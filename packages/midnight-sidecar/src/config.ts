/**
 * Midnight Sidecar Configuration
 *
 * All configuration loaded from environment variables.
 */

export type PredicateKind =
  | 'age'
  | 'kyc'
  | 'residency'
  | 'email'
  | 'nationality'
  | 'age_range'
  | 'personhood'

export const PREDICATE_KINDS: readonly PredicateKind[] = [
  'age',
  'kyc',
  'residency',
  'email',
  'nationality',
  'age_range',
  'personhood',
]

export type PredicateAddresses = Record<PredicateKind, string>

export interface SidecarConfig {
  port: number

  // Midnight network
  indexerUri: string
  indexerWsUri: string
  proofServerUri: string
  /** Node WebSocket URL (for wallet relay) */
  nodeWsUrl: string
  /** Network ID ('undeployed' for local devnet, 'preprod' for testnet) */
  networkId: string

  // Server wallet (used when no headless wallet seed is provided)
  coinPublicKey: string
  encryptionPublicKey: string

  // Contract addresses
  issuerRegistryAddress: string
  revocationRegistryAddress: string
  identityRegistryAddress: string
  // One contract per predicate (kept under per-extrinsic deploy weight
  // cap on devnet). Each address is independent + has its own attest
  // function exposed by the corresponding Compact contract.
  predicateAddresses: PredicateAddresses

  // Owner secret key for identity registry witness
  ownerSecretKey: string

  // Auth
  apiKey: string
}

export function loadConfig(): SidecarConfig {
  const required = (name: string): string => {
    const val = process.env[name]
    if (!val) {
      throw new Error(`Missing required env var: ${name}`)
    }
    return val
  }

  const optional = (name: string, fallback: string): string => {
    return process.env[name] ?? fallback
  }

  // When using a wallet seed OR mnemonic, coinPublicKey/encryptionPublicKey
  // are derived automatically by the headless wallet.
  const hasWalletSource =
    !!process.env.MIDNIGHT_WALLET_SEED || !!process.env.MIDNIGHT_WALLET_MNEMONIC
  const requireOrOptional = hasWalletSource ? (name: string) => optional(name, '') : required

  return {
    port: parseInt(optional('MIDNIGHT_SIDECAR_PORT', '3000'), 10),

    indexerUri: optional('MIDNIGHT_INDEXER_URI', 'http://localhost:8088/api/v3/graphql'),
    indexerWsUri: optional('MIDNIGHT_INDEXER_WS_URI', 'ws://localhost:8088/api/v3/graphql/ws'),
    proofServerUri: optional('MIDNIGHT_PROOF_SERVER_URI', 'http://localhost:6300'),
    nodeWsUrl: optional('MIDNIGHT_NODE_WS_URL', 'ws://localhost:9944'),
    networkId: optional('MIDNIGHT_NETWORK_ID', 'undeployed'),

    coinPublicKey: requireOrOptional('MIDNIGHT_COIN_PUBLIC_KEY'),
    encryptionPublicKey: requireOrOptional('MIDNIGHT_ENCRYPTION_PUBLIC_KEY'),

    issuerRegistryAddress: optional('MIDNIGHT_ISSUER_REGISTRY_ADDRESS', ''),
    revocationRegistryAddress: optional('MIDNIGHT_REVOCATION_REGISTRY_ADDRESS', ''),
    identityRegistryAddress: optional('MIDNIGHT_IDENTITY_REGISTRY_ADDRESS', ''),
    predicateAddresses: {
      age: optional('MIDNIGHT_PREDICATE_AGE_ADDRESS', ''),
      kyc: optional('MIDNIGHT_PREDICATE_KYC_ADDRESS', ''),
      residency: optional('MIDNIGHT_PREDICATE_RESIDENCY_ADDRESS', ''),
      email: optional('MIDNIGHT_PREDICATE_EMAIL_ADDRESS', ''),
      nationality: optional('MIDNIGHT_PREDICATE_NATIONALITY_ADDRESS', ''),
      age_range: optional('MIDNIGHT_PREDICATE_AGE_RANGE_ADDRESS', ''),
      personhood: optional('MIDNIGHT_PREDICATE_PERSONHOOD_ADDRESS', ''),
    },

    ownerSecretKey: optional('MIDNIGHT_OWNER_SECRET_KEY', ''),

    apiKey: required('MIDNIGHT_SIDECAR_API_KEY'),
  }
}
