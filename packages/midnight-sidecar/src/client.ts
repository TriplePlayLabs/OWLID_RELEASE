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

/** Why the client is not currently usable. Surfaced by /health so an
 *  operator sees the reason instead of a bare "not connected". */
let lastConnectError: string | null = null

export function getConnectError(): string | null {
  return lastConnectError
}

/** `joinContract` subscribes to indexer state and never settles when the
 *  address holds no contract — which is what a testnet reset looks like.
 *  Without a ceiling the whole connect hangs forever and the service serves
 *  500s with nothing in the logs. */
const CONNECT_TIMEOUT_MS = Number(process.env.MIDNIGHT_CONNECT_TIMEOUT_MS ?? 180_000)

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms).unref?.(),
    ),
  ])
}

/**
 * Confirm every configured contract address still exists on chain.
 *
 * A public testnet reset wipes deployed contracts, and `joinContract` reacts
 * to that by waiting for state that will never arrive. Checking first turns a
 * silent hang into a named error naming the dead addresses.
 */
async function assertContractsOnChain(config: SidecarConfig): Promise<void> {
  const configured: Array<[string, string]> = [
    ['issuerRegistry', config.issuerRegistryAddress],
    ['revocationRegistry', config.revocationRegistryAddress],
    ['identityRegistry', config.identityRegistryAddress],
    ...Object.entries(config.predicateAddresses),
  ].filter((e): e is [string, string] => Boolean(e[1]))

  const missing: string[] = []
  await Promise.all(
    configured.map(async ([name, address]) => {
      const res = await fetch(config.indexerUri, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `query($a:String!){ contractAction(address:$a){ __typename } }`,
          variables: { a: address },
        }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error(`indexer ${res.status} while checking ${name}`)
      const body = (await res.json()) as { data?: { contractAction?: unknown } }
      if (!body.data?.contractAction) missing.push(`${name}(${address.slice(0, 12)}…)`)
    }),
  )

  if (missing.length > 0) {
    throw new Error(
      `contracts absent from chain — redeploy and update the *_ADDRESS env vars: ${missing.join(', ')}`,
    )
  }
}

/**
 * Initialize and connect the MidnightClient singleton.
 * The client connects to all configured contract registries.
 */
export async function initClient(config: SidecarConfig): Promise<MidnightClient> {
  if (client?.isConnected()) {
    return client
  }
  try {
    const connected = await connectOnce(config)
    lastConnectError = null
    return connected
  } catch (e) {
    lastConnectError = e instanceof Error ? e.message : String(e)
    // Drop the half-built client so the next attempt starts clean; the wallet
    // supervisor is deliberately kept — rebuilding it costs a multi-minute
    // resync and the wallet is not what failed.
    client?.disconnect()
    client = null
    throw e
  }
}

async function connectOnce(config: SidecarConfig): Promise<MidnightClient> {
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

  if (!createWallet) {
    console.warn(
      '[client] No MIDNIGHT_WALLET_MNEMONIC or MIDNIGHT_WALLET_SEED set. ' +
        'Running in read-only mode (stub balanceTx/submitTx).',
    )
  } else if (!supervisor) {
    // Reconnect attempts reuse a live supervisor: a rebuild costs a
    // multi-minute wallet resync and the wallet is not what failed.
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

  await assertContractsOnChain(config)

  await withTimeout(
    client.connect({
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
    }),
    CONNECT_TIMEOUT_MS,
    'MidnightClient.connect',
  )

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
