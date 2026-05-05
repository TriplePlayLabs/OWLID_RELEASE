/**
 * MidnightClient singleton wrapper for the sidecar service.
 *
 * Passes config to the Node-only MidnightClient which builds
 * all providers internally (NodeZkConfigProvider, levelPrivateState, etc.).
 */

import { MidnightClient } from './midnight.js'
import type { SidecarConfig } from './config.js'
import { createHeadlessWallet, type HeadlessWallet } from './wallet.js'
import { join } from 'path'

let client: MidnightClient | null = null
let wallet: HeadlessWallet | null = null

/**
 * Initialize and connect the MidnightClient singleton.
 * The client connects to all configured contract registries.
 */
export async function initClient(config: SidecarConfig): Promise<MidnightClient> {
  if (client?.isConnected()) {
    return client
  }

  // Try to create a headless wallet for real transaction support
  const walletSeed = process.env.MIDNIGHT_WALLET_SEED
  if (walletSeed) {
    console.log('[client] Creating headless wallet for transaction support...')
    try {
      wallet = await createHeadlessWallet({
        seed: walletSeed,
        nodeWsUrl: config.nodeWsUrl,
        indexerUrl: config.indexerUri,
        indexerWsUrl: config.indexerWsUri,
        proofServerUrl: config.proofServerUri,
        networkId: config.networkId,
      })
      console.log('[client] Headless wallet ready.')
    } catch (e) {
      console.error('[client] Failed to create headless wallet:', e)
      console.warn('[client] Falling back to read-only mode (stub balanceTx/submitTx)')
    }
  } else {
    console.warn(
      '[client] No MIDNIGHT_WALLET_SEED set. Running in read-only mode (stub balanceTx/submitTx).',
    )
  }

  client = new MidnightClient({
    issuerRegistry: config.issuerRegistryAddress || undefined,
    revocationRegistry: config.revocationRegistryAddress || undefined,
    identityRegistry: config.identityRegistryAddress || undefined,
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
    proofServerUri: config.proofServerUri,
    managedDir,
    walletProvider: {
      getCoinPublicKey: () => wallet?.coinPublicKey ?? config.coinPublicKey,
      getEncryptionPublicKey: () => wallet?.encryptionPublicKey ?? config.encryptionPublicKey,
      balanceTx: wallet
        ? wallet.balanceTx
        : async (tx: unknown) => {
            console.warn('[client] balanceTx stub called - set MIDNIGHT_WALLET_SEED for real txs')
            return tx
          },
    },
    midnightProvider: {
      submitTx: wallet
        ? wallet.submitTx
        : async (_tx: unknown) => {
            console.warn('[client] submitTx stub called - set MIDNIGHT_WALLET_SEED for real txs')
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

/** Get the headless wallet (null if not configured) */
export function getWallet(): HeadlessWallet | null {
  return wallet
}

/** Disconnect and clean up */
export function disconnectClient(): void {
  client?.disconnect()
  client = null
  wallet?.close()
  wallet = null
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
