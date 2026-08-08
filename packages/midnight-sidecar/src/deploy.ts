#!/usr/bin/env bun
/**
 * Contract Deployment Script
 *
 * Deploys every Compact contract under `managed/` to a Midnight
 * network. The deploy table below is the SINGLE source of truth — to
 * add a new contract:
 *   1. Drop `contracts/foo.compact` + `bun run compact`
 *   2. Add a row to `DEPLOY_TABLE` (witnesses + initialPrivateState)
 *   3. Add the env-var name to `.env.example`
 *   4. Add the matching `midnight_<envSuffix>_address` variable to
 *      `deploy/gcp/terraform/variables.tf` + `run.tf` (sidecar env)
 *
 * On success the script writes every deployed address into BOTH `.env`
 * and `deploy/gcp/terraform/terraform.tfvars` — no manual copy-paste.
 *
 * Wallet source (one of):
 *   - MIDNIGHT_WALLET_MNEMONIC=<BIP39 12/24 words>   ← testnet/mainnet
 *   - MIDNIGHT_WALLET_SEED=<32-byte hex>             ← local devnet
 */

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts'
import { CompiledContract } from '@midnight-ntwrk/compact-js'
import { createInProcessProofProvider } from './inprocess-proof.js'
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider'
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider'

import { Contract as IssuerContract } from '../managed/issuer_registry/contract/index.js'
import { Contract as RevocationContract } from '../managed/revocation_registry/contract/index.js'
import { Contract as IdentityContract } from '../managed/identity_registry/contract/index.js'
import { Contract as PredicateAgeContract } from '../managed/predicate_age/contract/index.js'
import { Contract as PredicateAgeRangeContract } from '../managed/predicate_age_range/contract/index.js'
import { Contract as PredicateEmailContract } from '../managed/predicate_email/contract/index.js'
import { Contract as PredicateKycContract } from '../managed/predicate_kyc/contract/index.js'
import { Contract as PredicateNationalityContract } from '../managed/predicate_nationality/contract/index.js'
import { Contract as PredicatePersonhoodContract } from '../managed/predicate_personhood/contract/index.js'
import { Contract as PredicateResidencyContract } from '../managed/predicate_residency/contract/index.js'

import {
  createHeadlessWallet,
  createWalletFromMnemonic,
  DEVNET_GENESIS_SEED,
  getWalletBalances,
  ensureDustLanes,
  type HeadlessWallet,
} from './wallet.js'
import {
  createIdentityRegistryWitnesses,
  createRevocationRegistryWitnesses,
  createPredicateRegistryWitnesses,
} from './witnesses.js'
import { signingKeyFromBip340 } from '@midnight-ntwrk/ledger-v8'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/** True when `address` still holds a contract on the chain behind `indexerUri`.
 *  A public testnet reset removes every deployed contract, so an address that
 *  worked yesterday can be absent today. */
async function contractExistsOnChain(indexerUri: string, address: string): Promise<boolean> {
  try {
    const res = await fetch(indexerUri, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($a:String!){ contractAction(address:$a){ __typename } }`,
        variables: { a: address },
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return false
    const body = (await res.json()) as { data?: { contractAction?: unknown } }
    return Boolean(body.data?.contractAction)
  } catch {
    // Treat an unreachable indexer as "unknown", not "absent" — deploying on
    // top of a live contract would orphan it.
    throw new Error(`indexer unreachable while checking ${address.slice(0, 12)}…`)
  }
}

// =============================================================================
// Deploy table — one row per Compact contract.
// =============================================================================

interface DeployRow {
  /** managed/<name>/ directory + `.env` key suffix (uppercased). */
  name: string
  /** `MIDNIGHT_${envSuffix}_ADDRESS` is the env var that receives the
   *  deployed contract address. Keeps existing names stable. */
  envSuffix: string
  /** Compiled Contract class (TS binding). */
  contract: unknown
  /** Constructor witnesses. `() => any` so each row can read whatever
   *  closure state it needs (e.g. owner secret key). */
  witnesses: (ctx: DeployContext) => unknown
  /** Initial private state passed to the contract constructor. */
  initialPrivateState: (ctx: DeployContext) => unknown
  /** Constructor args (typed as `unknown[]` to keep the table small). */
  args: (ctx: DeployContext) => unknown[]
  /** Private-state id used by the level provider for this contract. */
  privateStateId: string
}

interface DeployContext {
  initialOwner: unknown
  ownerSecretKey: Buffer
}

const DEPLOY_TABLE: DeployRow[] = [
  {
    name: 'issuer_registry',
    envSuffix: 'ISSUER_REGISTRY',
    contract: IssuerContract,
    witnesses: () => undefined, // marker: use withVacantWitnesses
    initialPrivateState: () => ({}),
    args: (ctx) => [ctx.initialOwner],
    privateStateId: 'owlid-issuer-registry',
  },
  {
    name: 'revocation_registry',
    envSuffix: 'REVOCATION_REGISTRY',
    contract: RevocationContract,
    witnesses: () => createRevocationRegistryWitnesses(),
    initialPrivateState: () => ({}),
    args: (ctx) => [ctx.initialOwner],
    privateStateId: 'owlid-revocation-registry',
  },
  {
    name: 'identity_registry',
    envSuffix: 'IDENTITY_REGISTRY',
    contract: IdentityContract,
    witnesses: (ctx) => createIdentityRegistryWitnesses(ctx.ownerSecretKey),
    initialPrivateState: (ctx) => ({ secretKey: ctx.ownerSecretKey }),
    args: (ctx) => [ctx.initialOwner],
    privateStateId: 'owlid-identity-registry',
  },
  // Predicate registries (one per predicate, deployed independently to
  // keep each under Midnight's per-extrinsic block-weight cap).
  {
    name: 'predicate_age',
    envSuffix: 'PREDICATE_AGE',
    contract: PredicateAgeContract,
    witnesses: () => createPredicateRegistryWitnesses(() => ({})),
    initialPrivateState: () => ({}),
    args: (ctx) => [ctx.initialOwner],
    privateStateId: 'owlid-predicate-age',
  },
  {
    name: 'predicate_kyc',
    envSuffix: 'PREDICATE_KYC',
    contract: PredicateKycContract,
    witnesses: () => createPredicateRegistryWitnesses(() => ({})),
    initialPrivateState: () => ({}),
    args: (ctx) => [ctx.initialOwner],
    privateStateId: 'owlid-predicate-kyc',
  },
  {
    name: 'predicate_residency',
    envSuffix: 'PREDICATE_RESIDENCY',
    contract: PredicateResidencyContract,
    witnesses: () => createPredicateRegistryWitnesses(() => ({})),
    initialPrivateState: () => ({}),
    args: (ctx) => [ctx.initialOwner],
    privateStateId: 'owlid-predicate-residency',
  },
  {
    name: 'predicate_email',
    envSuffix: 'PREDICATE_EMAIL',
    contract: PredicateEmailContract,
    witnesses: () => createPredicateRegistryWitnesses(() => ({})),
    initialPrivateState: () => ({}),
    args: (ctx) => [ctx.initialOwner],
    privateStateId: 'owlid-predicate-email',
  },
  {
    name: 'predicate_nationality',
    envSuffix: 'PREDICATE_NATIONALITY',
    contract: PredicateNationalityContract,
    witnesses: () => createPredicateRegistryWitnesses(() => ({})),
    initialPrivateState: () => ({}),
    args: (ctx) => [ctx.initialOwner],
    privateStateId: 'owlid-predicate-nationality',
  },
  {
    name: 'predicate_age_range',
    envSuffix: 'PREDICATE_AGE_RANGE',
    contract: PredicateAgeRangeContract,
    witnesses: () => createPredicateRegistryWitnesses(() => ({})),
    initialPrivateState: () => ({}),
    args: (ctx) => [ctx.initialOwner],
    privateStateId: 'owlid-predicate-age-range',
  },
  {
    name: 'predicate_personhood',
    envSuffix: 'PREDICATE_PERSONHOOD',
    contract: PredicatePersonhoodContract,
    witnesses: () => createPredicateRegistryWitnesses(() => ({})),
    initialPrivateState: () => ({}),
    args: (ctx) => [ctx.initialOwner],
    privateStateId: 'owlid-predicate-personhood',
  },
]

// =============================================================================
// Env wiring
// =============================================================================

const walletMnemonic = process.env.MIDNIGHT_WALLET_MNEMONIC
const seed = process.env.MIDNIGHT_WALLET_SEED ?? DEVNET_GENESIS_SEED
const nodeWsUrl = process.env.MIDNIGHT_NODE_WS_URL ?? 'ws://localhost:9944'
const indexerUrl = process.env.MIDNIGHT_INDEXER_URI ?? 'http://localhost:8088/api/v3/graphql'
const indexerWsUrl = process.env.MIDNIGHT_INDEXER_WS_URI ?? 'ws://localhost:8088/api/v3/graphql/ws'
const proofServerUrl = process.env.MIDNIGHT_PROOF_SERVER_URI ?? 'http://localhost:6300'
const networkId = process.env.MIDNIGHT_NETWORK_ID ?? 'undeployed'

const contractsBase = join(import.meta.dir, '..', 'managed')

async function main() {
  console.log('=== OwlID Contract Deployment ===')
  console.log(`Network:      ${networkId}`)
  console.log(`Node:         ${nodeWsUrl}`)
  console.log(`Indexer:      ${indexerUrl}`)
  console.log(`Proving:      in-process WASM (no proof server)`)
  console.log()

  // ---- Wallet ----------------------------------------------------------
  console.log('[1/4] Creating headless wallet...')
  let wallet: HeadlessWallet
  if (walletMnemonic) {
    console.log('  source: MIDNIGHT_WALLET_MNEMONIC (BIP39)')
    wallet = await createWalletFromMnemonic(walletMnemonic.trim(), {
      nodeWsUrl,
      indexerUrl,
      indexerWsUrl,
      proofServerUrl,
      networkId,
    })
  } else {
    console.log(
      seed === DEVNET_GENESIS_SEED
        ? '  source: devnet genesis hex seed (pre-minted tokens)'
        : '  source: MIDNIGHT_WALLET_SEED (hex)',
    )
    wallet = await createHeadlessWallet({
      seed,
      nodeWsUrl,
      indexerUrl,
      indexerWsUrl,
      proofServerUrl,
      networkId,
    })
  }
  console.log(`  coinPublicKey: ${wallet.coinPublicKey.slice(0, 32)}...`)
  try {
    const bech32 = wallet.unshieldedKeystore.getBech32Address().asString()
    console.log(`  unshielded:    ${bech32}`)
  } catch {
    /* older SDKs may not expose this; non-fatal. */
  }
  const balances = await getWalletBalances(wallet, networkId)
  const night = balances.unshielded + balances.shielded
  console.log(`  NIGHT balance: ${night}`)
  console.log(`  DUST balance:  ${balances.dust}`)
  // Without NIGHT there is no DUST, and every deploy below fails. Stopping
  // here keeps the run from writing a half-updated address set, where the
  // contracts that failed keep pointing at addresses from a previous chain.
  if (night === 0n && balances.dust === 0n) {
    console.error()
    console.error(`  ERROR: wallet holds no NIGHT on '${networkId}'.`)
    console.error(`  Fund it, then re-run. Address:`)
    console.error(`    ${balances.unshieldedAddr}`)
    if (networkId === 'preview') {
      console.error(`  Faucet: https://faucet.preview.midnight.network`)
    }
    console.error()
    console.error(`  A public testnet reset zeroes the balance AND removes every`)
    console.error(`  deployed contract, so a reset means re-funding and re-deploying.`)
    wallet.close()
    process.exit(1)
  }
  // Deploying 10 contracts back-to-back needs real dust, and a freshly funded
  // wallet has a single NIGHT UTXO — one dust lane, generating slowly. Splitting
  // into K lanes multiplies the generation rate and gives the deploy loop K
  // disjoint dust UTXOs to balance against instead of contending on one.
  //
  // This also closes the race that made the first post-reset deploy fail all 10
  // contracts: registration alone returns as soon as dust is merely non-zero,
  // which is far below what a deploy can spend.
  const lanes = Number(process.env.DEPLOY_DUST_LANES ?? 8)
  const minDust = BigInt(process.env.DEPLOY_MIN_DUST ?? 3_000_000_000_000_000n)
  console.log(`  Ensuring ${lanes} dust lanes and >= ${minDust} dust...`)
  const ready = await ensureDustLanes(wallet, { lanes, minDust })
  console.log(`  Dust lanes: ${ready.lanes}, dust balance: ${ready.dust}`)
  if (ready.dust < minDust) {
    console.error()
    console.error(`  ERROR: dust is ${ready.dust}, below the ${minDust} needed to deploy.`)
    console.error(`  DUST accrues over time from registered NIGHT — wait and re-run.`)
    wallet.close()
    process.exit(1)
  }
  console.log()

  // ---- Providers + context --------------------------------------------
  console.log('[2/4] Setting up providers...')
  const walletProvider = {
    getCoinPublicKey: () => wallet.coinPublicKey,
    getEncryptionPublicKey: () => wallet.encryptionPublicKey,
    balanceTx: wallet.balanceTx,
  }
  const midnightProvider = { submitTx: wallet.submitTx }

  // ONE admin key for the whole contract lifecycle.
  //
  // `MIDNIGHT_OWNER_SECRET_KEY` is both:
  //   - the contract owner (identity-registry witnesses, owner-only ops), and
  //   - the contract MAINTENANCE AUTHORITY — the key the ledger checks on
  //     `insertVerifierKey` / `removeVerifierKey` / `replaceAuthority`, which
  //     are the only way to upgrade a circuit without minting a new address.
  //
  // It must be durable. When `signingKey` is omitted midnight-js mints a random
  // authority and keeps it solely in the private-state LevelDB; losing that
  // directory forfeits upgrades on every contract it deployed. Passing the key
  // explicitly makes the authority reproducible from Secret Manager alone.
  // Deliberately fatal when unset. Generating one here would hand back a key
  // that exists nowhere durable, and the contracts it deployed could never be
  // upgraded in place — a failure that only surfaces months later, when it is
  // unfixable. Refusing to deploy is the recoverable outcome.
  const ownerHex = process.env.MIDNIGHT_OWNER_SECRET_KEY?.trim()
  if (!ownerHex) {
    throw new Error(
      'MIDNIGHT_OWNER_SECRET_KEY is required — it is the contract owner AND the ' +
        'maintenance authority (the key that authorises in-place circuit upgrades). ' +
        'Load it with:\n' +
        '  export MIDNIGHT_OWNER_SECRET_KEY=$(gcloud secrets versions access latest \\\n' +
        '    --secret=midnight-owner-secret-key --project=owlid-491411)',
    )
  }
  if (!/^[0-9a-fA-F]{64}$/.test(ownerHex)) {
    throw new Error('MIDNIGHT_OWNER_SECRET_KEY must be 32-byte hex (64 chars)')
  }
  const ownerSecretKey = Buffer.from(ownerHex, 'hex')
  const signingKey = signingKeyFromBip340(ownerSecretKey)
  console.log('  Admin key: MIDNIGHT_OWNER_SECRET_KEY (owner + maintenance authority)')
  const providersBase = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'owlid-deploy-state',
      privateStoragePasswordProvider: () =>
        process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD ?? 'Owlid-Deploy#2026!local',
      accountId: 'deploy',
    }),
    publicDataProvider: indexerPublicDataProvider(indexerUrl, indexerWsUrl),
    walletProvider,
    midnightProvider,
  }
  const coinPubKeyBytes = Buffer.from(wallet.coinPublicKey, 'hex')
  const initialOwner = {
    is_left: true,
    left: { bytes: new Uint8Array(coinPubKeyBytes) },
    right: { bytes: new Uint8Array(32) },
  }
  const ctx: DeployContext = { initialOwner, ownerSecretKey }
  console.log('  Providers ready.')
  console.log()

  // ---- Deploy loop ----------------------------------------------------
  // Filter by `CONTRACTS=name1,name2,...` env var (comma-separated; the
  // names match the `row.name` column in DEPLOY_TABLE, e.g.
  // `predicate_residency`). Empty => deploy everything (default).
  const onlyRaw = process.env.CONTRACTS?.trim() ?? ''
  const only = onlyRaw
    ? new Set(
        onlyRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null
  const table = only ? DEPLOY_TABLE.filter((r) => only.has(r.name)) : DEPLOY_TABLE
  if (only) {
    const unknown = [...only].filter((n) => !DEPLOY_TABLE.some((r) => r.name === n))
    if (unknown.length > 0) {
      throw new Error(`CONTRACTS filter has unknown names: ${unknown.join(', ')}`)
    }
  }
  console.log(
    `[3/4] Deploying ${table.length} contracts${only ? ` (filter: ${[...only].join(', ')})` : ''}...`,
  )
  console.log()
  const addresses: Record<string, string> = {}
  const failures: Array<{ name: string; error: string }> = []
  const kept: string[] = []

  // Maintenance mode (the default): a contract whose configured address is
  // still live on chain is kept as-is and not redeployed.
  //
  // Midnight has no in-place upgrade — `deployContract` derives the address
  // from the deploy transaction, so ANY redeploy mints a new address. Keeping
  // an address stable therefore means not redeploying that contract. This
  // makes re-runs idempotent: after a partial failure or a testnet reset,
  // only the contracts that are actually missing get deployed, and the rest
  // keep their addresses (and, for predicates, their attestation history).
  //
  // Set REDEPLOY_ALL=true to force a fresh address for every contract — which
  // is what you want after changing a contract's Compact source.
  const redeployAll = process.env.REDEPLOY_ALL === 'true'

  for (const row of table) {
    process.stdout.write(`  ${row.name.padEnd(24)} `)
    try {
      if (!redeployAll) {
        const existing = process.env[`MIDNIGHT_${row.envSuffix}_ADDRESS`]?.trim()
        if (existing && (await contractExistsOnChain(indexerUrl, existing))) {
          addresses[row.envSuffix] = existing
          kept.push(row.name)
          console.log(`kept   ${existing}`)
          continue
        }
      }
      const zkConfigProvider = new NodeZkConfigProvider(join(contractsBase, row.name))
      // Compact-generated Contract classes vary in type per managed/<n>,
      // but at runtime midnight-js works on the structural shape only —
      // cast through `any` so the deploy table can hold them uniformly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ContractClass = row.contract as any
      const witnessesObj = row.witnesses(ctx)
      const builder = (
        CompiledContract.make as (
          n: string,
          c: unknown,
        ) => {
          pipe(...fns: unknown[]): unknown
        }
      )(row.name.replace(/_/g, '-'), ContractClass)
      const compiled = builder.pipe(
        witnessesObj === undefined
          ? CompiledContract.withVacantWitnesses
          : (CompiledContract.withWitnesses as (w: unknown) => unknown)(witnessesObj),
        (CompiledContract.withCompiledFileAssets as (p: string) => unknown)(
          join(contractsBase, row.name),
        ),
      )
      const deployed = await (deployContract as Function)(
        {
          ...providersBase,
          zkConfigProvider,
          proofProvider: createInProcessProofProvider(zkConfigProvider),
        },
        {
          compiledContract: compiled,
          privateStateId: row.privateStateId,
          initialPrivateState: row.initialPrivateState(ctx),
          args: row.args(ctx),
          // Fixes the maintenance authority to the admin key. Omitting this
          // lets midnight-js mint a random one into local-only private state.
          signingKey,
        },
      )
      const addr = (deployed as { deployTxData: { public: { contractAddress: string } } })
        .deployTxData.public.contractAddress
      addresses[row.envSuffix] = addr
      console.log(addr)
    } catch (e) {
      const msg = (e as { message?: string }).message ?? String(e)
      failures.push({ name: row.name, error: msg })
      console.log(`FAIL — ${msg}`)
    }
  }
  console.log()

  // ---- Write .env + terraform.tfvars ---------------------------------
  console.log('[4/4] Updating .env + terraform.tfvars...')
  const repoRoot = join(import.meta.dir, '..', '..', '..')
  const envPath = join(repoRoot, '.env')
  let envContent = readFileSync(envPath, 'utf-8')

  const envEntries: Record<string, string> = {
    MIDNIGHT_OWNER_SECRET_KEY: ownerSecretKey.toString('hex'),
  }
  for (const [suffix, addr] of Object.entries(addresses)) {
    envEntries[`MIDNIGHT_${suffix}_ADDRESS`] = addr
  }

  for (const [key, value] of Object.entries(envEntries)) {
    const re = new RegExp(`^${key}=.*$`, 'm')
    if (re.test(envContent)) {
      envContent = envContent.replace(re, `${key}=${value}`)
    } else {
      // Append unknown keys at the end so new contract entries don't get
      // silently dropped on the first deploy.
      envContent += `\n${key}=${value}\n`
    }
  }
  writeFileSync(envPath, envContent)
  console.log(`  Updated: ${envPath}`)

  // terraform.tfvars carries the deployed (preview/testnet/mainnet) contract
  // addresses for Cloud Run. A LOCAL devnet deploy (networkId 'undeployed')
  // must NOT touch it — its addresses are local-only and would clobber the
  // preview addresses Terraform applies to GCP. Only real (non-local) deploys
  // update tfvars.
  const tfvarsPath = join(repoRoot, 'deploy', 'gcp', 'terraform', 'terraform.tfvars')
  if (networkId === 'undeployed') {
    console.log(
      `  Skipped terraform.tfvars (local network '${networkId}' — preview addresses preserved)`,
    )
  } else {
    try {
      let tfvars = readFileSync(tfvarsPath, 'utf-8')
      let updated = 0
      const missing: string[] = []
      for (const [suffix, addr] of Object.entries(addresses)) {
        const tfKey = `midnight_${suffix.toLowerCase()}_address`
        const re = new RegExp(`^(${tfKey}\\s*=\\s*)"[^"]*"`, 'm')
        if (re.test(tfvars)) {
          tfvars = tfvars.replace(re, `$1"${addr}"`)
          updated++
        } else {
          missing.push(tfKey)
        }
      }
      writeFileSync(tfvarsPath, tfvars)
      console.log(`  Updated: ${tfvarsPath} (${updated}/${DEPLOY_TABLE.length} vars)`)
      if (missing.length > 0) {
        console.log(`  WARNING tfvars missing keys (add them manually): ${missing.join(', ')}`)
      }
    } catch {
      console.log(`  Skipped terraform.tfvars (not present at ${tfvarsPath})`)
    }
  }
  console.log()

  // ---- Summary --------------------------------------------------------
  console.log('=== Deployment Complete ===')
  console.log()
  const freshCount = Object.keys(addresses).length - kept.length
  console.log(
    `${freshCount} newly deployed, ${kept.length} kept (already on chain), ` +
      `${DEPLOY_TABLE.length} total:`,
  )
  for (const [suffix, addr] of Object.entries(addresses)) {
    console.log(`  ${suffix.padEnd(24)} ${addr}`)
  }
  if (kept.length > 0) {
    console.log()
    console.log(`Kept (re-run with REDEPLOY_ALL=true to mint new addresses): ${kept.join(', ')}`)
  }
  if (failures.length > 0) {
    console.log()
    console.log(`Failed (${failures.length}):`)
    for (const f of failures) {
      console.log(`  ${f.name}: ${f.error}`)
    }
    // The written files now mix fresh addresses with whatever the failed
    // contracts had before. Those stale entries point at contracts that may
    // not exist, which the sidecar reports as a chain-connect failure rather
    // than anything resembling "the deploy was incomplete".
    console.log()
    console.log('  WARNING: partial deploy. These still hold their PREVIOUS address')
    console.log('  and must not be shipped — re-run until every contract succeeds:')
    for (const f of failures) {
      const row = DEPLOY_TABLE.find((r) => r.name === f.name)
      if (row) console.log(`    midnight_${row.envSuffix.toLowerCase()}_address`)
    }
  }

  wallet.close()
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('Deployment failed:', e)
  process.exit(1)
})
