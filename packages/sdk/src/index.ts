/**
 * @owlid/sdk — TypeScript SDK for the OwlID platform.
 *
 * Public surface:
 *   - `OwlVerifier` — server-side client for verifying SD-JWT VC presentations
 *   - `OwlIssuer`   — server-side client for issuing SD-JWT VC credentials
 *   - Holder helpers (`presentSdJwtVc`, `KeyPair`, `SdJwtVc`, `verifySdJwt`)
 *   - WebAuthn unlock/UV helpers, encoding, storage, presentation protocol
 */

// =============================================================================
// Ergonomic platform clients (preferred surface)
// =============================================================================
export {
  OwlVerifier,
  type OwlVerifierOptions,
  type VerificationResult,
  type Challenge,
  type IssuerInfo as VerifiedIssuerInfo,
  type RevocationEvent,
  type PresentationSession,
  type PresentationRequestOptions,
} from './verifier/index.js'

export {
  OwlIssuer,
  type OwlIssuerOptions,
  type Claims,
  type Holder,
  type HolderAlgorithm,
  type IssuanceSession,
  type SessionStart,
  type FormField,
  type IssuedClaims,
  type IssuedCredential,
  type ProviderInfo,
} from './issuer.js'

export { respondToPresentation, presentSdJwtVc, type RespondOptions } from './present.js'

export {
  OwlWallet,
  matchDcqlAgainst,
  type OwlWalletOptions,
  type WalletPresentRequest,
  type WalletPresentResult,
  type DcqlMatchEntry,
  type DcqlMatchSummary,
  type UnwrapHolderKeyFn,
} from './wallet.js'

// Progress signal surfaced from `OwlWallet.present` so the holder app's
// consent screen can show per-predicate "Generating proof…" /
// "Submitting to Midnight…" copy instead of a silent ~20-30s pause on
// the first presentation of a credential. The orchestrator itself
// stays internal — only the event shape is public.
export type { AttestProgress, EnsureResult } from './midnight/index.js'

// Re-export DCQL request/response types from the generated verifier
// client so SDK consumers don't have to import @owlid/verifier-client.
export type {
  DcqlRequest,
  DcqlCredentialQuery,
  DcqlMeta,
  DcqlClaimQuery,
  DcqlCredentialSet,
  VerifyDcqlRequest,
  VerifyDcqlResponse,
  VerifyResponse,
} from '@owlid/verifier-client'

// =============================================================================
// Configuration (advanced — most apps use OwlVerifier / OwlIssuer instead).
// Re-exported from `@owlid/config`, the canonical home — direct imports
// from `@owlid/config` are equivalent.
// =============================================================================
export {
  type RuntimeConfig,
  type ProvingMode,
  configure,
  getConfig,
  getVerificationUrl,
  getIssuerUrl,
  getApiKey,
  apiKeyHeaders,
  getWsBaseUrl,
  getProvingMode,
  getProofServerUrl,
  toWsUrl,
  resolveWsUrl,
} from '@owlid/config'

// =============================================================================
// Holder SD-JWT VC primitives (pure TS, browser + Node)
// =============================================================================
// Implementation: `@noble/ed25519` + `@noble/hashes`. Bytes match
// `owl_proof_system::sd_jwt`, so any verifier accepts presentations
// minted here unchanged. No platform binaries, no WASM plumbing.
export { KeyPair, PublicKey, SdJwtVc, verifySdJwt } from './sd-jwt.js'
export type { KbInput } from './sd-jwt.js'

// =============================================================================
// Encoding utilities
// =============================================================================
export {
  bufferToBase64,
  base64ToBuffer,
  bufferToBase64url,
  base64urlToBuffer,
  bytesToHex,
  hexToBytes,
} from './encoding.js'

// =============================================================================
// WebAuthn core
// =============================================================================
export {
  type WebAuthnSignatureResult,
  type WebAuthnRegistrationResult,
  type WebAuthnRegistrationOptions,
  type WebAuthnAuthenticationOptions,
  extractPublicKeyFromAttestation,
  coseKeyToP256Hex,
  parseCoseKey,
  registerCredential,
  signChallenge,
  authenticate,
  isWebAuthnSupported,
  isPlatformAuthenticatorAvailable,
  wrapHolderKey,
  unwrapHolderKey,
} from './webauthn.js'

// =============================================================================
// Storage — multi-credential wallet
// =============================================================================
export {
  type StoredWebAuthnCredential,
  type WalletCredential,
  type CardShape,
  type VerifiedClaims,
  type StorageAdapter,
  STORAGE_KEYS,
  browserStorageAdapter,
  CredentialStorageManager,
  buildCardShape,
  storage,
} from './storage.js'

// =============================================================================
// Holder proof persistence + typed proof errors (sub-barrel)
// =============================================================================
export {
  type StoredProof,
  ProofStorageManager,
  proofStorage,
  type ProofErrorCode,
  type ProofError,
  parseProofError,
  isPredicateNotSatisfied,
} from './proofs/index.js'

// =============================================================================
// Reference data (kept in sync with the platform's issuance normalisation)
// =============================================================================
export { EU_ALPHA2 } from './eu-countries.js'
export {
  ALL_COUNTRIES,
  EU_COUNTRIES,
  COUNTRY_PRESETS,
  countryByAlpha2,
  countryName,
  isAlpha2,
  isEuCountry,
  toAlpha2,
  type Country,
} from './countries.js'

// =============================================================================
// Presentation Protocol (ISO 18013-5 style)
// =============================================================================
export {
  type SessionEngagement,
  type PresentationRequest,
  type PresentationResponse,
  type WsMessage,
  type WsMessageType,
  type WsError,
  type ProofFailedPayload,
  encodeSessionEngagement,
  decodeSessionEngagement,
  isPresentationEngagement,
  sessionIdFromWsUrl,
  isSdJwtVc,
} from './presentation.js'

export {
  owlCredentialQuery,
  readOwlPredicate,
  expectOwlPredicate,
  type OwlPredicate,
} from './owl-dcql.js'

// =============================================================================
// Declarative predicates — the ergonomic verifier surface
// =============================================================================
// Build a list of `Predicates.xxx(...)` calls instead of hand-writing
// DCQL claim paths. `OwlVerifier.requestPredicates({ predicates })`
// compiles them to the on-wire DCQL format, drives the QR + WebSocket
// flow, and returns the verified result.
export {
  Predicates,
  buildDcqlRequest,
  OWL_DCQL_FORMAT,
  type PredicateRequest,
} from './predicates.js'

// Holder-side wallet routing — `OwlWallet.present` consumes these
// internally; exposed so a holder app can pre-flight what a DCQL
// query would route to before prompting the user for consent.
export { routeClaim, attestationCovers } from './midnight/routing.js'
export type { RoutedPredicate, OwlAttestationRef } from './midnight/routing.js'

// Note: the Midnight-specific helpers (proveAttestationUnsubmitted,
// the in-process prover, snapshot encoding, the merkle tree builder,
// the on-chain attestation key recipes, `ensureMidnightNetworkConfigured`)
// stay internal under `./midnight/`. SDK consumers go through
// `OwlVerifier` / `OwlWallet` / `OwlIssuer` and never import
// `@midnight-ntwrk/*` types directly.
