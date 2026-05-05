/**
 * Headless Wallet for Midnight (v2.0.0)
 *
 * Creates a server-side wallet from an HD seed, providing balanceTx/submitTx
 * for contract deployment and transaction submission without a browser wallet.
 *
 * On a local devnet (CFG_PRESET=dev), the genesis seed '0...01' has pre-minted tokens.
 */

import * as ledger from '@midnight-ntwrk/ledger-v8'
import { type DefaultConfiguration, WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade'
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet'
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd'
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded'
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
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
    provingServerUrl: new URL(config.proofServerUrl),
    relayURL: new URL(config.nodeWsUrl),
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000n,
      feeBlocksMargin: 5,
    },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
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
  console.log('[wallet] Waiting for wallet to sync (timeout: 120s)...')

  await waitForSync(wallet.facade, 120_000)

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
  await waitForSync(wallet.facade, 120_000)

  return wallet
}

/** Wait for wallet to report isSynced === true */
export async function waitForSync(facade: WalletFacade, timeoutMs = 120_000): Promise<void> {
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
