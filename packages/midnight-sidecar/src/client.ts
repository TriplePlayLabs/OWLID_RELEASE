/**
 * MidnightClient singleton wrapper for the sidecar service.
 *
 * Passes config to the Node-only MidnightClient which builds
 * all providers internally (NodeZkConfigProvider, levelPrivateState, etc.).
 */

import { MidnightClient, type ContractAddresses } from './midnight.js'
import type { SidecarConfig } from './config.js'
import { createHeadlessWallet, createWalletFromMnemonic, type HeadlessWallet } from './wallet.js'
import { startWalletSupervisor, type WalletSupervisor } from './wallet-supervisor.js'
import { join } from 'path'

let client: MidnightClient | null = null
let supervisor: WalletSupervisor | null = null

/**
 * Initialize and connect the MidnightClient singleton.
 * The client connects to all configured contract registries.
 */
export async function initClient(config: SidecarConfig): Promise<MidnightClient> {
  if (client?.isConnected()) {
    return client
  }

  // The headless wallet that signs + submits txs. Two sources, checked
  // in this order:
  //   1. MIDNIGHT_WALLET_MNEMONIC — BIP39 phrase (12 / 24 words). Use
  //      for testnet / mainnet deploys with a real Midnight wallet.
  //   2. MIDNIGHT_WALLET_SEED — 32-byte hex seed. Local devnet only
  //      (the `0…01` genesis seed has pre-minted tokens on
  //      `CFG_PRESET=dev`).
  // Without either, the sidecar runs read-only (stub balanceTx/submitTx).
  //
  // `createWallet` is a fresh-wallet factory: the supervisor calls it
  // both for the initial wallet and for every in-place rebuild during
  // recovery, so it must stay side-effect-free beyond producing a
  // synced HeadlessWallet.
  const walletMnemonic = process.env.MIDNIGHT_WALLET_MNEMONIC
  const walletSeed = process.env.MIDNIGHT_WALLET_SEED
  const walletConfig = {
    nodeWsUrl: config.nodeWsUrl,
    indexerUrl: config.indexerUri,
    indexerWsUrl: config.indexerWsUri,
    proofServerUrl: config.proofServerUri,
    networkId: config.networkId,
  }
  const createWallet: (() => Promise<HeadlessWallet>) | null = walletMnemonic
    ? () => createWalletFromMnemonic(walletMnemonic.trim(), walletConfig)
    : walletSeed
      ? () => createHeadlessWallet({ seed: walletSeed, ...walletConfig })
      : null

  if (createWallet) {
    console.log(`[client] Creating headless wallet (${walletMnemonic ? 'mnemonic' : 'seed'})...`)
    try {
      // The supervisor keeps the wallet synced and rebuilds it in place
      // if the live sync degrades — see wallet-supervisor.ts.
      supervisor = await startWalletSupervisor(createWallet)
      console.log('[client] Headless wallet ready (supervised).')
    } catch (e) {
      console.error('[client] Failed to create supervised wallet:', e)
      console.warn('[client] Falling back to read-only mode (stub balanceTx/submitTx)')
    }
  } else {
    console.warn(
      '[client] No MIDNIGHT_WALLET_MNEMONIC or MIDNIGHT_WALLET_SEED set. ' +
        'Running in read-only mode (stub balanceTx/submitTx).',
    )
  }

  client = new MidnightClient({
    issuerRegistry: config.issuerRegistryAddress || undefined,
    revocationRegistry: config.revocationRegistryAddress || undefined,
    identityRegistry: config.identityRegistryAddress || undefined,
    // Each kind gets its own address; absent values are dropped (the
    // ContractAddresses type allows partial coverage so an under-deployed
    // env still boots the sidecar).
    predicates: Object.fromEntries(
      Object.entries(config.predicateAddresses).filter(([, a]) => a),
    ) as ContractAddresses['predicates'],
  })

  // Set owner secret key BEFORE connect (needed for identity registry witnesses)
  if (config.ownerSecretKey) {
    const keyBytes = hexToBytes(config.ownerSecretKey)
    client.setOwnerSecretKey(keyBytes)
  }

  // Path to compiled contract managed/ directories (local to sidecar)
  const managedDir = join(import.meta.dir, '..', 'managed')

  await client.connect({
    indexerUri: config.indexerUri,
    indexerWsUri: config.indexerWsUri,
    managedDir,
    walletProvider: {
      getCoinPublicKey: () => supervisor?.getWallet().coinPublicKey ?? config.coinPublicKey,
      getEncryptionPublicKey: () =>
        supervisor?.getWallet().encryptionPublicKey ?? config.encryptionPublicKey,
      // Route through the supervisor. With the Lace-style submit
      // path the balance + submit are fused into a single serialized
      // step (`supervisor.submitTx`) — so the wallet provider's
      // `balanceTx` is a pass-through identity. The midnight-js
      // contract layer always calls `balanceTx` then `submitTx`; by
      // returning the raw tx here we defer all the real work to
      // `submitTx` where preflight + retry + serializer apply.
      balanceTx: supervisor
        ? async (tx: unknown) => {
            await supervisor!.ensureReady()
            return tx
          }
        : async (tx: unknown) => {
            console.warn(
              '[client] balanceTx stub called — set MIDNIGHT_WALLET_MNEMONIC ' +
                '(testnet/mainnet) or MIDNIGHT_WALLET_SEED (devnet) for real txs',
            )
            return tx
          },
    },
    midnightProvider: {
      submitTx: supervisor
        ? async (tx: unknown) => {
            return supervisor!.submitTx(tx)
          }
        : async (_tx: unknown) => {
            console.warn(
              '[client] submitTx stub called — set MIDNIGHT_WALLET_MNEMONIC ' +
                '(testnet/mainnet) or MIDNIGHT_WALLET_SEED (devnet) for real txs',
            )
            return 'stub-tx-hash'
          },
    },
  })

  return client
}

/** Get the current client instance (throws if not initialized) */
export function getClient(): MidnightClient {
  if (!client || !client.isConnected()) {
    throw new Error('MidnightClient not initialized. Call initClient() first.')
  }
  return client
}

/** Get the current headless wallet (null in read-only mode). The
 *  reference changes across supervisor rebuilds — never cache it. */
export function getWallet(): HeadlessWallet | null {
  return supervisor?.getWallet() ?? null
}

/** Get the wallet supervisor (null in read-only mode). */
export function getWalletSupervisor(): WalletSupervisor | null {
  return supervisor
}

/** Disconnect and clean up */
export function disconnectClient(): void {
  client?.disconnect()
  client = null
  void supervisor?.stop()
  supervisor = null
}

/** Convert hex string to Uint8Array */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/** Convert Uint8Array to hex string */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
