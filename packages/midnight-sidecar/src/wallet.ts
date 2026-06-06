/**
 * Headless Wallet for Midnight (v2.0.0)
 *
 * Creates a server-side wallet from an HD seed, providing balanceTx/submitTx
 * for contract deployment and transaction submission without a browser wallet.
 *
 * On a local devnet (CFG_PRESET=dev), the genesis seed '0...01' has pre-minted tokens.
 */

import * as ledger from '@midnight-ntwrk/ledger-v8'
import {
  type DefaultConfiguration,
  mergeWalletEntries,
  WalletEntrySchema,
  WalletFacade,
} from '@midnight-ntwrk/wallet-sdk-facade'
import {
  makeServerProvingService,
  makeWasmProvingService,
} from '@midnight-ntwrk/wallet-sdk-capabilities/proving'
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet'
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd'
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded'
// `InMemoryTransactionHistoryStorage` moved to wallet-sdk-abstractions
// in the 3.0 wave (unshielded-wallet dropped its `storage/` re-exports).
import { InMemoryTransactionHistoryStorage } from '@midnight-ntwrk/wallet-sdk-abstractions'
import {
  createKeystore,
  PublicKey as UnshieldedPublicKey,
  type UnshieldedKeystore,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet'
import {
  DustAddress,
  MidnightBech32m,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk-address-format'
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id'
import { WebSocket } from 'ws'
import * as Rx from 'rxjs'
import * as bip39 from '@scure/bip39'
import { wordlist as english } from '@scure/bip39/wordlists/english.js'

// Required for GraphQL subscriptions in Node.js
// @ts-expect-error: Needed to enable WebSocket usage through apollo/graphql-ws
globalThis.WebSocket = WebSocket

/** Genesis mint wallet seed for local devnet (CFG_PRESET=dev) */
export const DEVNET_GENESIS_SEED =
  '0000000000000000000000000000000000000000000000000000000000000001'

export interface WalletConfig {
  /** HD wallet seed (hex string). Use DEVNET_GENESIS_SEED for local devnet. */
  seed: string
  /** Midnight node WebSocket URL (e.g., ws://localhost:9944) */
  nodeWsUrl: string
  /** Indexer HTTP URL (e.g., http://localhost:8088/api/v3/graphql) */
  indexerUrl: string
  /** Indexer WebSocket URL (e.g., ws://localhost:8088/api/v3/graphql/ws) */
  indexerWsUrl: string
  /** Proof server URL (e.g., http://localhost:6300) */
  proofServerUrl: string
  /** Network ID ('undeployed' for local devnet, 'preprod' for testnet) */
  networkId?: string
}

export interface HeadlessWallet {
  /** The wallet facade managing all sub-wallets */
  facade: WalletFacade
  /** Shielded (zswap) secret keys */
  secretKeys: ledger.ZswapSecretKeys
  /** Dust secret key */
  dustSecretKey: ledger.DustSecretKey
  /** Unshielded keystore for signing */
  unshieldedKeystore: UnshieldedKeystore
  /** Coin public key (hex) for receiving transactions */
  coinPublicKey: string
  /** Encryption public key (hex) */
  encryptionPublicKey: string
  /** Balance a transaction (add inputs/outputs/fees) */
  balanceTx: (tx: unknown, newCoins?: unknown) => Promise<unknown>
  /** Reserve a balanced tx's UTXOs (mark pending) so the next balance picks
   *  different ones. Run inside the same critical section as its `balanceTx`. */
  reserve: (balanced: unknown) => Promise<void>
  /** Broadcast a reserved tx to the mempool, returning at `'Submitted'` (node
   *  accepted it). Does NOT revert on failure — the caller reverts under its
   *  serializer. Safe to run OUTSIDE the balance lock so submits pipeline. */
  broadcast: (balanced: unknown) => Promise<unknown>
  /** Release a reserved tx's pending UTXOs (idempotent). */
  revert: (balanced: unknown) => Promise<void>
  /** Fused reserve+broadcast+revert-on-fail for non-pipelined callers. */
  submitTx: (tx: unknown) => Promise<unknown>
  /** Shut down the wallet cleanly */
  close: () => Promise<void>
}

/** Convert mnemonic phrase to seed buffer using BIP39 */
export async function mnemonicToSeed(mnemonic: string): Promise<Buffer> {
  const words = mnemonic.trim().split(/\s+/)
  if (!bip39.validateMnemonic(words.join(' '), english)) {
    throw new Error('Invalid mnemonic phrase')
  }
  const seed = await bip39.mnemonicToSeed(words.join(' '))
  return Buffer.from(seed)
}

/**
 * Initialize wallet keys and facade from a seed buffer.
 */
async function initWalletFromSeed(seed: Buffer, config: WalletConfig): Promise<HeadlessWallet> {
  const networkId = config.networkId ?? 'undeployed'
  setNetworkId(networkId)

  // Derive keys from HD seed
  const hdWallet = HDWallet.fromSeed(seed)
  if (hdWallet.type !== 'seedOk') {
    throw new Error('Failed to initialize HDWallet from seed')
  }

  const derivation = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0)

  if (derivation.type !== 'keysDerived') {
    throw new Error('Failed to derive keys from HD wallet')
  }

  hdWallet.hdWallet.clear()

  // Create secret keys from derived seeds using ledger-v8 APIs
  const secretKeys = ledger.ZswapSecretKeys.fromSeed(derivation.keys[Roles.Zswap])
  const dustSecretKey = ledger.DustSecretKey.fromSeed(derivation.keys[Roles.Dust])
  const unshieldedKeystore = createKeystore(derivation.keys[Roles.NightExternal], networkId)

  // Build DefaultConfiguration (v2.0.0)
  const configuration: DefaultConfiguration = {
    networkId,
    indexerClientConnection: {
      indexerHttpUrl: config.indexerUrl,
      indexerWsUrl: config.indexerWsUrl,
    },
    // No `provingServerUrl`: proving is in-process WASM (see the
    // `provingService` override in WalletFacade.init below).
    relayURL: new URL(config.nodeWsUrl),
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000n,
      feeBlocksMargin: 5,
    },
    // SDK 4.0 requires a schema-typed history store. Pass the
    // facade-exported `WalletEntrySchema` + `mergeWalletEntries` so
    // serialize/restore round-trips through the canonical wallet
    // history shape. The sidecar doesn't currently consume the
    // history, but the SDK now requires it.
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
  }

  // Initialize via WalletFacade.init() (v2.0.0 — constructor is private)
  const facade: WalletFacade = await WalletFacade.init({
    configuration,
    shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(secretKeys),
    unshielded: (cfg) =>
      UnshieldedWallet(cfg).startWithPublicKey(
        UnshieldedPublicKey.fromKeyStore(unshieldedKeystore),
      ),
    dust: (cfg) =>
      DustWallet(cfg).startWithSecretKey(
        dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
      ),
    // The wallet's balance/dust re-prove leg. In-process WASM is portable
    // but slow (~10s/balance measured) and serializes on one CPU. When a
    // proof server is configured, offload to it (~0.2s measured) — it's the
    // dominant cost in the relay submit pipeline. Because that makes the proof
    // server a hard dependency on every balance, wrap it with an in-process
    // WASM FALLBACK: a proof-server outage then merely slows balances instead
    // of failing every submit. Unset ⇒ pure WASM.
    provingService: () => {
      const url = config.proofServerUrl?.trim()
      if (!url) {
        console.log(
          '[wallet] balance proving in-process (WASM); set MIDNIGHT_PROOF_SERVER_URI to offload',
        )
        return makeWasmProvingService()
      }
      console.log(`[wallet] balance proving via proof server ${url} (WASM fallback on error)`)
      const server = makeServerProvingService({ provingServerUrl: new URL(url) })
      let wasmFallback: ReturnType<typeof makeWasmProvingService> | null = null
      return {
        prove: async (tx) => {
          try {
            return await server.prove(tx)
          } catch (e) {
            console.warn(
              `[wallet] proof-server prove failed, falling back to WASM: ${
                e instanceof Error ? e.message : String(e)
              }`,
            )
            wasmFallback ??= makeWasmProvingService()
            return wasmFallback.prove(tx)
          }
        },
      }
    },
  })

  // Start the wallet sync (critical! without this the wallet never connects)
  await facade.start(secretKeys, dustSecretKey)

  const coinPublicKey = secretKeys.coinPublicKey
  const encryptionPublicKey = secretKeys.encryptionPublicKey

  return {
    facade,
    secretKeys,
    dustSecretKey,
    unshieldedKeystore,
    coinPublicKey,
    encryptionPublicKey,

    async balanceTx(tx: unknown, _newCoins?: unknown): Promise<unknown> {
      const recipe = await facade.balanceUnboundTransaction(
        tx as any,
        { secretKeys, dustSecretKey } as any,
        { ttl: new Date(Date.now() + 30 * 60 * 1000) },
      )

      // Sign transaction intents
      const signFn = (payload: Uint8Array) => unshieldedKeystore.signData(payload)
      signTransactionIntents(recipe.baseTransaction as any, signFn, 'proof')
      if ((recipe as any).balancingTransaction) {
        signTransactionIntents((recipe as any).balancingTransaction, signFn, 'pre-proof')
      }

      return facade.finalizeRecipe(recipe)
    },

    async reserve(tx: unknown): Promise<void> {
      // Atomically reserve this balanced tx's dust/coin UTXOs (mark pending).
      // `availableCoins = utxos − pending`, so once this returns the next
      // balance excludes these UTXOs — that is what lets submits pipeline.
      const f = facade as unknown as {
        pendingTransactionsService: { addPendingTransaction: (t: unknown) => Promise<void> }
      }
      await f.pendingTransactionsService.addPendingTransaction(tx)
    },

    async broadcast(tx: unknown): Promise<unknown> {
      // Return at `'Submitted'` — the node accepted the tx into the mempool
      // (where validity rejects like RpcError 1010 surface), NOT `'InBlock'`.
      // Block inclusion + GRANDPA finality are tracked out-of-band (the relay
      // SSE / `watchForTxData`), so the wallet is freed at mempool acceptance
      // instead of holding through a whole block. No revert here: the caller
      // reverts under its serializer so pending state is never mutated under a
      // concurrent balance's UTXO selection.
      const f = facade as unknown as {
        submissionService: { submitTransaction: (t: unknown, w?: string) => Promise<unknown> }
      }
      await f.submissionService.submitTransaction(tx, 'Submitted')
      return (tx as { identifiers: () => string[] }).identifiers().at(-1)
    },

    async revert(tx: unknown): Promise<void> {
      const f = facade as unknown as { revertTransaction: (t: unknown) => Promise<void> }
      await f.revertTransaction(tx)
    },

    async submitTx(tx: unknown): Promise<unknown> {
      const f = facade as unknown as {
        pendingTransactionsService: { addPendingTransaction: (t: unknown) => Promise<void> }
        submissionService: { submitTransaction: (t: unknown, w?: string) => Promise<unknown> }
        revertTransaction: (t: unknown) => Promise<void>
      }
      await f.pendingTransactionsService.addPendingTransaction(tx)
      try {
        await f.submissionService.submitTransaction(tx, 'Submitted')
        return (tx as { identifiers: () => string[] }).identifiers().at(-1)
      } catch (e) {
        await f.revertTransaction(tx).catch(() => undefined)
        throw e
      }
    },

    async close(): Promise<void> {
      try {
        await facade.stop()
      } catch (e) {
        console.error(`[wallet] Error closing wallet: ${e}`)
      }
    },
  }
}

/**
 * Create a headless wallet from a hex seed and wait for sync.
 */
export async function createHeadlessWallet(config: WalletConfig): Promise<HeadlessWallet> {
  console.log(
    `[wallet] Initializing headless wallet (network: ${config.networkId ?? 'undeployed'})...`,
  )

  const seed = Buffer.from(config.seed, 'hex')
  const wallet = await initWalletFromSeed(seed, config)

  console.log(`[wallet] coinPublicKey: ${wallet.coinPublicKey.slice(0, 16)}...`)
  console.log(
    `[wallet] Waiting for wallet to sync (timeout: ${Math.round(DEFAULT_SYNC_TIMEOUT_MS / 1000)}s, ` +
      `override via MIDNIGHT_WALLET_SYNC_TIMEOUT_MS)...`,
  )

  await waitForSync(wallet.facade)

  console.log('[wallet] Synced.')
  return wallet
}

/**
 * Create a headless wallet from a BIP39 mnemonic and wait for sync.
 */
export async function createWalletFromMnemonic(
  mnemonic: string,
  config: Omit<WalletConfig, 'seed'>,
): Promise<HeadlessWallet> {
  const seed = await mnemonicToSeed(mnemonic)
  const wallet = await initWalletFromSeed(seed, { ...config, seed: '' })

  console.log(`[wallet] Wallet address: ${wallet.unshieldedKeystore.getBech32Address().asString()}`)
  console.log('[wallet] Waiting for wallet to sync...')
  await waitForSync(wallet.facade)

  return wallet
}

/** Default cold-sync timeout. Devnet syncs in ~30s; preview testnet
 *  needs minutes the first time (weeks of blocks to scan). Override
 *  with `MIDNIGHT_WALLET_SYNC_TIMEOUT_MS`. */
const DEFAULT_SYNC_TIMEOUT_MS = Number(
  process.env.MIDNIGHT_WALLET_SYNC_TIMEOUT_MS ?? 30 * 60 * 1000,
)

/** Wait for wallet to report isSynced === true */
export async function waitForSync(
  facade: WalletFacade,
  timeoutMs: number = DEFAULT_SYNC_TIMEOUT_MS,
): Promise<void> {
  await Promise.race([
    Rx.firstValueFrom(
      facade.state().pipe(
        Rx.throttleTime(5_000),
        Rx.tap((state) => console.log(`[wallet] Sync status: ${state.isSynced}`)),
        Rx.filter((s: any) => s.isSynced),
      ),
    ),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Wallet sync timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ])
}

/** Wait for wallet to have a positive NIGHT balance */
export async function waitForFunds(facade: WalletFacade): Promise<bigint> {
  return Rx.firstValueFrom(
    facade.state().pipe(
      Rx.throttleTime(10_000),
      Rx.tap((state) => {
        const unshielded = state.unshielded?.balances[ledger.nativeToken().raw] ?? 0n
        const shielded = state.shielded?.balances[ledger.nativeToken().raw] ?? 0n
        console.log(
          `[wallet] Waiting for funds. Synced: ${state.isSynced}, Balance: ${unshielded + shielded}`,
        )
      }),
      Rx.filter((state) => state.isSynced),
      Rx.map(
        (s) =>
          (s.unshielded?.balances[ledger.nativeToken().raw] ?? 0n) +
          (s.shielded?.balances[ledger.nativeToken().raw] ?? 0n),
      ),
      Rx.filter((balance) => balance > 0n),
    ),
  )
}

/** Get wallet balances and addresses */
export interface WalletBalances {
  unshieldedAddr: string
  shieldedAddr: string
  dustAddr: string
  unshielded: bigint
  shielded: bigint
  dust: bigint
}

export async function getWalletBalances(
  wallet: HeadlessWallet,
  networkId: string,
): Promise<WalletBalances> {
  const state = await Rx.firstValueFrom(wallet.facade.state())
  const unshielded = state.unshielded?.balances[ledger.nativeToken().raw] ?? 0n
  const shielded = state.shielded?.balances[ledger.nativeToken().raw] ?? 0n
  const dust = state.dust?.balance(new Date()) ?? 0n

  const unshieldedAddr = wallet.unshieldedKeystore.getBech32Address().asString()
  const shieldedAddr = MidnightBech32m.encode(networkId, state.shielded.address).asString()
  const dustAddr = DustAddress.encodePublicKey(networkId, wallet.dustSecretKey.publicKey)

  return { unshieldedAddr, shieldedAddr, dustAddr, unshielded, shielded, dust }
}

/** Aggregate DUST generation telemetry across all registered NIGHT
 *  UTXOs the wallet currently owns. Mirrors Lace's
 *  `DustGenerationDetails` shape (`packages/module/blockchain-midnight/
 *  src/store/side-effects/watch.ts`) so an operator can answer:
 *    - is dust accruing? (`rate > 0n`)
 *    - is it about to cap? (`maxCapReachedAt`)
 *    - is it decaying because a backing NIGHT was spent? (`decayTime`)
 *    - how much runway do I have at the current rate? (caller's job)
 *
 *  Uses `facade.estimateRegistration` for the rate model — same call
 *  Lace uses to decide whether to surface the "designate NIGHT" CTA.
 *  Returns `null` when the wallet has no registered NIGHT (and so no
 *  dust generation is happening).
 */
export interface DustGenerationHealth {
  /** Sum of currently-generated dust across all backing NIGHT UTXOs. */
  currentValue: bigint
  /** Sum of `gen.value * night_dust_ratio` across UTXOs — the ceiling
   *  the wallet would hit if it never spent dust. */
  maxCap: bigint
  /** Sum of per-UTXO generation rates (Specks per ms, expressed in
   *  the SDK's native units). Multiplying by elapsed ms gives accrual. */
  rate: bigint
  /** Earliest moment any backing NIGHT was spent — after this point
   *  the corresponding dust starts decaying. Undefined means none of
   *  the backing NIGHTs have been spent yet. */
  decayTimeMs: number | undefined
  /** Latest moment any UTXO hits its max cap — past this point that
   *  UTXO stops accruing. */
  maxCapReachedAtMs: number | undefined
  /** Number of registered NIGHT UTXOs feeding the rate. */
  registeredNightCount: number
  /** Number of NIGHT UTXOs NOT registered for dust generation — these
   *  produce no dust until `registerNightForDust` runs over them. */
  unregisteredNightCount: number
  /** Per-UTXO breakdown. Aggregates above lose signal once one backing
   *  NIGHT is spent (only THAT UTXO decays). Per-coin gives operators
   *  the precise picture without summing in their head. */
  perCoin: ReadonlyArray<{
    /** Hex-encoded UTXO value (NIGHT face value), informational. */
    nightValue: string
    generatedNow: string
    maxCap: string
    rate: string
    decayTimeMs: number | undefined
    maxCapReachedAtMs: number | undefined
  }>
}

export async function dustGenerationHealth(
  wallet: HeadlessWallet,
): Promise<DustGenerationHealth | null> {
  const state = (await Rx.firstValueFrom(wallet.facade.state())) as any
  const allNight: any[] = state.unshielded?.availableCoins ?? []
  const registered = allNight.filter((c) => c.meta?.registeredForDustGeneration)
  const unregistered = allNight.filter((c) => !c.meta?.registeredForDustGeneration)
  if (registered.length === 0) {
    return {
      currentValue: 0n,
      maxCap: 0n,
      rate: 0n,
      decayTimeMs: undefined,
      maxCapReachedAtMs: undefined,
      registeredNightCount: 0,
      unregisteredNightCount: unregistered.length,
      perCoin: [],
    }
  }

  // `estimateRegistration` computes per-utxo dust generation details —
  // same call Lace uses for its dust-designation preview.
  let details: ReadonlyArray<any> = []
  try {
    const est = await (
      wallet.facade as unknown as {
        estimateRegistration: (
          utxos: readonly any[],
        ) => Promise<{ dustGenerationEstimations: ReadonlyArray<any> }>
      }
    ).estimateRegistration(registered)
    details = est.dustGenerationEstimations
  } catch {
    details = []
  }

  let currentValue = 0n
  let maxCap = 0n
  let rate = 0n
  let earliestDecay: number | undefined
  let latestMaxCap: number | undefined
  const perCoin: Array<{
    nightValue: string
    generatedNow: string
    maxCap: string
    rate: string
    decayTimeMs: number | undefined
    maxCapReachedAtMs: number | undefined
  }> = []
  for (const d of details) {
    const dg = d.dust
    if (!dg) continue
    const coinCurrent = BigInt(dg.generatedNow ?? 0n)
    const coinMaxCap = BigInt(dg.maxCap ?? 0n)
    const coinRate = BigInt(dg.rate ?? 0n)
    currentValue += coinCurrent
    maxCap += coinMaxCap
    rate += coinRate
    const dtime = dg.dtime ? new Date(dg.dtime).getTime() : undefined
    const maxCapAt = dg.maxCapReachedAt ? new Date(dg.maxCapReachedAt).getTime() : undefined
    if (dtime !== undefined && (earliestDecay === undefined || dtime < earliestDecay)) {
      earliestDecay = dtime
    }
    if (maxCapAt !== undefined && (latestMaxCap === undefined || maxCapAt > latestMaxCap)) {
      latestMaxCap = maxCapAt
    }
    const nightValue = d.utxo?.utxo?.value ?? d.utxo?.value ?? ''
    perCoin.push({
      nightValue: String(nightValue ?? ''),
      generatedNow: coinCurrent.toString(),
      maxCap: coinMaxCap.toString(),
      rate: coinRate.toString(),
      decayTimeMs: dtime,
      maxCapReachedAtMs: maxCapAt,
    })
  }
  return {
    currentValue,
    maxCap,
    rate,
    decayTimeMs: earliestDecay,
    maxCapReachedAtMs: latestMaxCap,
    registeredNightCount: registered.length,
    unregisteredNightCount: unregistered.length,
    perCoin,
  }
}

/** Read-only diagnostic snapshot of the wallet's live sync + balance
 *  state. Used to investigate why the deployed sidecar fails to balance
 *  dust while a fresh sync of the same wallet does not. */
export async function walletDiagnosticSnapshot(
  wallet: HeadlessWallet,
): Promise<Record<string, unknown>> {
  const state = (await Rx.firstValueFrom(wallet.facade.state())) as any
  const now = new Date()
  const ut = ledger.nativeToken().raw
  const safe = <T>(fn: () => T): T | string => {
    try {
      return fn()
    } catch (e) {
      return `err:${e}`
    }
  }
  const unshieldedCoins: any[] = state.unshielded?.availableCoins ?? []
  // Dust UTXO state — what the SDK balancer actually picks from.
  // `availableCoins` are spendable; `pendingCoins` are dust outputs
  // consumed by in-flight tx that haven't finalized yet. The
  // aggregate `dust` balance includes the *projected* generation
  // from registered NIGHT UTXOs and may exceed the sum of
  // availableCoins — when balancer says "Insufficient Funds: could
  // not balance dust" with dust > 0, the spread between them is the
  // diagnosis.
  const dustAvailable: any[] = state.dust?.availableCoins ?? []
  const dustPending: any[] = state.dust?.pendingCoins ?? []
  return {
    time: now.toISOString(),
    isSynced: state.isSynced,
    syncProgress: {
      shielded: safe(() => state.shielded?.state?.progress?.isStrictlyComplete()),
      unshielded: safe(() => state.unshielded?.progress?.isStrictlyComplete()),
      dust: safe(() => state.dust?.state?.progress?.isStrictlyComplete()),
    },
    progressRaw: {
      shielded: safe(() => JSON.stringify(state.shielded?.state?.progress, bigintReplacer)),
      unshielded: safe(() => JSON.stringify(state.unshielded?.progress, bigintReplacer)),
      dust: safe(() => JSON.stringify(state.dust?.state?.progress, bigintReplacer)),
    },
    night: {
      unshielded: String(state.unshielded?.balances?.[ut] ?? 0n),
      shielded: String(state.shielded?.balances?.[ut] ?? 0n),
    },
    dust: String(safe(() => state.dust?.balance(now) ?? 0n)),
    unshieldedUtxoCount: unshieldedCoins.length,
    unshieldedUtxos: unshieldedCoins.map((c) => ({
      registeredForDust: c.meta?.registeredForDustGeneration,
      value: String(c.value ?? c.amount ?? ''),
    })),
    dustAvailableCount: dustAvailable.length,
    dustPendingCount: dustPending.length,
    dustAvailableSample: dustAvailable.slice(0, 5).map((c) => ({
      value: String(c.value ?? c.initialValue ?? c.amount ?? ''),
      ctime: c.ctime ? new Date(Number(c.ctime)).toISOString() : null,
    })),
    dustPendingSample: dustPending.slice(0, 5).map((c) => ({
      value: String(c.value ?? c.initialValue ?? c.amount ?? ''),
    })),
  }
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? `${v}n` : v
}

/**
 * Register unshielded NIGHT UTXOs for DUST generation.
 * Required before the wallet can pay transaction fees.
 *
 * `waitForDust` controls whether the call blocks until `dust.balance`
 * becomes positive. Deploy.ts wants this (it's the one-shot bootstrap
 * and downstream code immediately expects dust). The supervisor's
 * periodic loop does NOT want it — the wait is unbounded and would
 * wedge the single-writer serializer for the lifetime of one block.
 */
export async function registerNightForDust(
  wallet: HeadlessWallet,
  options: { waitForDust?: boolean; syncTimeoutMs?: number } = {},
): Promise<boolean> {
  const waitForDust = options.waitForDust ?? true
  // Strict `isSynced` (lag === 0) can stay false indefinitely on
  // preview while `isCompleteWithin` says ready. Bound the wait so a
  // caller running inside the supervisor's single-writer serializer
  // cannot deadlock the chain when sync lag never collapses to zero.
  const syncTimeoutMs = options.syncTimeoutMs ?? 30_000
  const state = await Rx.firstValueFrom(
    Rx.race(
      wallet.facade.state().pipe(Rx.filter((s) => s.isSynced)),
      Rx.timer(syncTimeoutMs).pipe(
        Rx.map(() => {
          throw new Error(`registerNightForDust: wallet not isSynced within ${syncTimeoutMs}ms`)
        }),
      ),
    ),
  )

  const unregisteredUtxos =
    state.unshielded?.availableCoins.filter(
      (coin) => coin.meta.registeredForDustGeneration === false,
    ) ?? []

  if (unregisteredUtxos.length === 0) {
    const dustBalance = state.dust?.balance(new Date()) ?? 0n
    console.log(`[wallet] No unregistered UTXOs. Current dust balance: ${dustBalance}`)
    return dustBalance > 0n
  }

  console.log(`[wallet] Registering ${unregisteredUtxos.length} NIGHT UTXOs for dust generation...`)

  try {
    const recipe = await wallet.facade.registerNightUtxosForDustGeneration(
      unregisteredUtxos,
      wallet.unshieldedKeystore.getPublicKey(),
      (payload) => wallet.unshieldedKeystore.signData(payload),
    )

    const finalized = await wallet.facade.finalizeRecipe(recipe)
    const txId = await wallet.facade.submitTransaction(finalized)
    console.log(`[wallet] Dust registration submitted: ${txId}`)

    if (waitForDust) {
      await Rx.firstValueFrom(
        wallet.facade.state().pipe(
          Rx.throttleTime(5_000),
          Rx.tap((s) => console.log(`[wallet] Dust balance: ${s.dust?.balance(new Date()) ?? 0n}`)),
          Rx.filter((s) => (s.dust?.balance(new Date()) ?? 0n) > 0n),
        ),
      )
      console.log('[wallet] Dust registration complete.')
    } else {
      console.log('[wallet] Dust registration submitted (not waiting for confirmation).')
    }
    return true
  } catch (e) {
    console.error(`[wallet] Failed to register DUST: ${e}`)
    return false
  }
}

/**
 * Transfer NIGHT tokens from one wallet to a receiver address.
 */
export async function transferNight(
  senderWallet: HeadlessWallet,
  receiverAddress: UnshieldedAddress,
  amount: bigint,
): Promise<string> {
  const ttl = new Date(Date.now() + 30 * 60 * 1000)

  const recipe = await senderWallet.facade.transferTransaction(
    [
      {
        type: 'unshielded',
        outputs: [
          {
            type: ledger.nativeToken().raw,
            receiverAddress,
            amount,
          },
        ],
      },
    ],
    {
      shieldedSecretKeys: senderWallet.secretKeys,
      dustSecretKey: senderWallet.dustSecretKey,
    },
    { ttl },
  )

  const signed = await senderWallet.facade.signRecipe(recipe, (payload) =>
    senderWallet.unshieldedKeystore.signData(payload),
  )

  const finalized = await senderWallet.facade.finalizeRecipe(signed)
  return await senderWallet.facade.submitTransaction(finalized)
}

/**
 * Sign all unsigned intents in a transaction.
 */
function signTransactionIntents(
  tx: any,
  signFn: (payload: Uint8Array) => string,
  _marker?: string,
): void {
  if (!tx?.intents) return
  for (const intent of tx.intents) {
    if (intent.type === 'unsigned') {
      intent.signature = signFn(intent.payload)
      intent.type = 'signed'
    }
  }
}
