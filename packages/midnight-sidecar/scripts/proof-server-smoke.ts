#!/usr/bin/env bun
/**
 * Real proof-server smoke. Exercises the hosted proof server end-to-
 * end with one of the per-kind predicate circuits — fetch the
 * contract snapshot from the live verification-service, build the
 * unproven attestation tx locally, send it to the proof server, and
 * confirm we got back a serializable proven tx.
 *
 * Does NOT relay the tx (no on-chain effect, no DUST spent). Pure
 * proof-server round-trip test.
 *
 *   bun run packages/midnight-sidecar/scripts/proof-server-smoke.ts --kind=email
 *   bun run packages/midnight-sidecar/scripts/proof-server-smoke.ts --kind=residency
 *
 * Env: read from .env via `bun --env-file=.env run …` or process env:
 *   VERIFICATION_SERVICE_URL  default https://api.owlid.app
 *   API_KEY                   verifier publishable key (owlid_pk_*)
 *   MIDNIGHT_PROOF_SERVER_URI default https://proofs.owlid.app
 *   MIDNIGHT_PREDICATE_<KIND>_ADDRESS — must match the contract on chain
 *   MIDNIGHT_NETWORK_ID       default 'undeployed' (use 'TestNet' on preview)
 */

import { CompiledContract } from '@midnight-ntwrk/compact-js'
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider'
import { setNetworkId, NetworkId } from '@midnight-ntwrk/midnight-js-network-id'
import { configure } from '@owlid/config'
import { join } from 'node:path'

const VERIFY_URL_EARLY = process.env.VERIFICATION_SERVICE_URL ?? 'https://api.owlid.app'
const API_KEY_EARLY = process.env.API_KEY ?? process.env.API_KEY_DEV ?? ''

// Configure @owlid/config so the verifier-client's getMonitoringApi /
// getPredicatesApi pick up apiKey + base url before prove.ts pulls them.
configure({ verificationUrl: VERIFY_URL_EARLY, apiKey: API_KEY_EARLY })

setNetworkId((process.env.MIDNIGHT_NETWORK_ID ?? 'undeployed') as NetworkId)

import {
  buildAllowedSetTree,
  findPathForCountry,
  padCountry,
  proveAttestationUnsubmitted,
  treeRootBytesLE,
  type MerkleTreePath,
  type PredicateSnapshot,
} from '@owlid/sdk/midnight'

type Kind = 'email' | 'age' | 'residency' | 'nationality'

const VERIFY_URL = process.env.VERIFICATION_SERVICE_URL ?? 'https://api.owlid.app'
const PROOF_URL = process.env.MIDNIGHT_PROOF_SERVER_URI ?? 'https://proofs.owlid.app'
const API_KEY = process.env.API_KEY ?? process.env.API_KEY_DEV ?? ''

if (!API_KEY) {
  console.error('missing API_KEY (set VERIFIER pk_* key or owlid_sk_* key)')
  process.exit(1)
}

const ROOT = new Uint8Array(32).fill(0xc3)
const enc = new TextEncoder()

function hex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
}

async function sha256(...chunks: Uint8Array[]): Promise<Uint8Array> {
  const len = chunks.reduce((a, c) => a + c.length, 0)
  const buf = new Uint8Array(len)
  let o = 0
  for (const c of chunks) {
    buf.set(c, o)
    o += c.length
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf))
}

async function buildSetMembership(
  client: string,
  codes: string[],
  holderCountry: string,
): Promise<{
  setHash: Uint8Array
  pathWitness: MerkleTreePath<Uint8Array>
  verifierIdHash: Uint8Array
}> {
  const built = buildAllowedSetTree(codes)
  const pathWitness = findPathForCountry(built, holderCountry)
  const rootBytes = treeRootBytesLE(built.tree)
  const verifierIdHash = await sha256(enc.encode(client))
  const setHash = await sha256(verifierIdHash, rootBytes)
  return { setHash, pathWitness, verifierIdHash }
}

const SPECS: Record<
  Kind,
  () => Promise<{
    envAddr: string
    managedDir: string
    contractModule: string
    circuitId: string
    witnesses: Record<string, unknown>
    args: unknown[]
    privateStateId: string
  }>
> = {
  email: async () => ({
    envAddr: 'MIDNIGHT_PREDICATE_EMAIL_ADDRESS',
    managedDir: 'predicate_email',
    contractModule: '../managed/predicate_email/contract/index.js',
    circuitId: 'attestEmailVerified',
    witnesses: {
      emailVerifiedFlag: (ctx: { privateState: unknown }) => [ctx.privateState, 1n],
    },
    args: [ROOT],
    privateStateId: 'owlid-predicate-email',
  }),
  age: async () => ({
    envAddr: 'MIDNIGHT_PREDICATE_AGE_ADDRESS',
    managedDir: 'predicate_age',
    contractModule: '../managed/predicate_age/contract/index.js',
    circuitId: 'attestAgeGte',
    witnesses: {
      ageValue: (ctx: { privateState: unknown }) => [ctx.privateState, 30n],
    },
    args: [ROOT, 18n],
    privateStateId: 'owlid-predicate-age',
  }),
  residency: async () => {
    const { setHash, pathWitness, verifierIdHash } = await buildSetMembership(
      'https://verifier.owlid.app',
      ['NL', 'BE', 'DE'],
      'NL',
    )
    return {
      envAddr: 'MIDNIGHT_PREDICATE_RESIDENCY_ADDRESS',
      managedDir: 'predicate_residency',
      contractModule: '../managed/predicate_residency/contract/index.js',
      circuitId: 'attestResidencyIn',
      witnesses: {
        residentCountry: (ctx: { privateState: unknown }) => [ctx.privateState, padCountry('NL')],
        verifierIdHash: (ctx: { privateState: unknown }) => [ctx.privateState, verifierIdHash],
        allowedCountryPath: (ctx: { privateState: unknown }) => [ctx.privateState, pathWitness],
      },
      args: [ROOT, setHash],
      privateStateId: 'owlid-predicate-residency',
    }
  },
  nationality: async () => {
    const { setHash, pathWitness, verifierIdHash } = await buildSetMembership(
      'https://verifier.owlid.app',
      ['NL', 'BE', 'DE'],
      'NL',
    )
    return {
      envAddr: 'MIDNIGHT_PREDICATE_NATIONALITY_ADDRESS',
      managedDir: 'predicate_nationality',
      contractModule: '../managed/predicate_nationality/contract/index.js',
      circuitId: 'attestNationalityIn',
      witnesses: {
        nationalityCode: (ctx: { privateState: unknown }) => [ctx.privateState, padCountry('NL')],
        verifierIdHash: (ctx: { privateState: unknown }) => [ctx.privateState, verifierIdHash],
        allowedCountryPath: (ctx: { privateState: unknown }) => [ctx.privateState, pathWitness],
      },
      args: [ROOT, setHash],
      privateStateId: 'owlid-predicate-nationality',
    }
  },
}

function parseKind(): Kind {
  const arg = process.argv.find((a) => a.startsWith('--kind='))
  const raw = (arg ? arg.slice('--kind='.length) : 'email') as Kind
  if (!(raw in SPECS)) throw new Error(`--kind must be one of ${Object.keys(SPECS).join(', ')}`)
  return raw
}

async function main(): Promise<void> {
  const kind = parseKind()
  const spec = await SPECS[kind]()

  console.log(`=== proof-server smoke: ${kind} ===`)
  console.log(`  verify:       ${VERIFY_URL}`)
  console.log(`  proof-server: ${PROOF_URL}`)
  console.log(`  circuit:      ${spec.circuitId}`)
  console.log()

  // 1. snapshot via verification-service
  const snapResp = await fetch(`${VERIFY_URL}/predicates/${kind}/snapshot`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  })
  if (!snapResp.ok) {
    throw new Error(`snapshot fetch failed: ${snapResp.status} ${await snapResp.text()}`)
  }
  const snapshot = (await snapResp.json()) as PredicateSnapshot
  console.log(`[1] snapshot ok (address=${snapshot.address.slice(0, 16)}…)`)

  // 2. compile contract w/ witness
  const contractMod = await import(spec.contractModule)
  const ContractClass = contractMod.Contract
  const base = join(import.meta.dir, '..', 'managed')
  const zk = new NodeZkConfigProvider(join(base, spec.managedDir))
  const compiled = CompiledContract.make(`predicate-${kind}`, ContractClass).pipe(
    CompiledContract.withWitnesses(spec.witnesses as never) as never,
    CompiledContract.withCompiledFileAssets(join(base, spec.managedDir)) as never,
  )

  // 3. prove via hosted proof server
  console.log(`[2] proving via proof-server ${PROOF_URL}…`)
  const t0 = Date.now()
  try {
    const provenTx = await proveAttestationUnsubmitted({
      compiledContract: compiled as never,
      zkConfigProvider: zk as never,
      snapshot,
      circuitId: spec.circuitId,
      args: spec.args,
      privateStateId: spec.privateStateId,
      proofProvider: { mode: 'proof-server', url: PROOF_URL },
    })
    console.log(`[2] PROOF OK: ${provenTx.length}B in ${Date.now() - t0}ms`)
    console.log(`    head: ${hex(provenTx.subarray(0, 32))}`)
    process.exit(0)
  } catch (e) {
    console.error(`[2] PROOF FAILED in ${Date.now() - t0}ms:`)
    console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e))
    if (e instanceof Error && e.stack) console.error(e.stack)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('script crashed:', e)
  process.exit(1)
})
