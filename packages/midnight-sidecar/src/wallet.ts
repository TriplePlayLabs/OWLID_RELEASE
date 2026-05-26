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
import { makeWasmProvingService } from '@midnight-ntwrk/wallet-sdk-capabilities/proving'
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
  /** Submit a balanced transaction to the network */
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
    // The wallet's balance/dust re-prove leg uses the wallet SDK's own
    // in-process WASM prover (`@midnight-ntwrk/wallet-sdk-prover-client`)
    // instead of an external proof server, overriding the URL-based
    // default. This covers only the standard wallet (zswap/dust) circuits
    // — the holder's per-kind predicate proof is a separate path.
    provingService: () => makeWasmProvingService(),
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

    async submitTx(tx: unknown): Promise<unknown> {
      return facade.submitTransaction(tx as any)
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
 */
export async function registerNightForDust(wallet: HeadlessWallet): Promise<boolean> {
  const state = await Rx.firstValueFrom(wallet.facade.state().pipe(Rx.filter((s) => s.isSynced)))

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

    // Wait for dust to appear
    await Rx.firstValueFrom(
      wallet.facade.state().pipe(
        Rx.throttleTime(5_000),
        Rx.tap((s) => console.log(`[wallet] Dust balance: ${s.dust?.balance(new Date()) ?? 0n}`)),
        Rx.filter((s) => (s.dust?.balance(new Date()) ?? 0n) > 0n),
      ),
    )

    console.log('[wallet] Dust registration complete.')
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
