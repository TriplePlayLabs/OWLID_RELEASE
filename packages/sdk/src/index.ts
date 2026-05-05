/**
 * @owlid/sdk — TypeScript SDK for the OwlID platform.
 *
 * Public surface:
 *   - `OwlVerifier` — server-side client for verifying tokens
 *   - `OwlIssuer`   — server-side client for issuing credentials
 *   - Token primitives (`Credential`, `Token`, `KeyPair`) — holder-side crypto
 *   - WebAuthn helpers, encoding, storage, presentation protocol
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
} from './verifier.js'

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

export {
  respondToPresentation,
  signToken,
  signTokenWithPasskey,
  type HolderSigner,
  type PresentationConsentRequest,
  type RespondOptions,
  type SignTokenOptions,
  type SignTokenWithPasskeyOptions,
} from './holder.js'

// =============================================================================
// Configuration (advanced — most apps use OwlVerifier / OwlIssuer instead)
// =============================================================================
export {
  type RuntimeConfig,
  configure,
  getConfig,
  getVerificationUrl,
  getIssuerUrl,
  getApiKey,
  apiKeyHeaders,
  getWsBaseUrl,
  toWsUrl,
  resolveWsUrl,
} from './config.js'

// =============================================================================
// Native SDK (Rust/WASM cryptographic primitives)
// =============================================================================
// Type-only re-exports so consumers can reference proof shapes without
// pulling the WASM payload. Runtime classes and hash helpers live behind
// the explicit `@owlid/sdk/native` subpath:
//
//     import { Token, blake3 } from '@owlid/sdk/native'
//
// Importing the subpath is what loads the WASM module. See the bundler
// integration guide for the Vite / Webpack setup it expects.
export type { ProofRequest, PredicateRequest, WebAuthnSignatureData } from '@owlid/native-sdk'

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
} from './webauthn.js'

// =============================================================================
// Storage
// =============================================================================
export {
  type StoredWebAuthnCredential,
  type StoredCredentialData,
  type Credential as StoredCredential,
  type VerifiedClaims,
  type IdentityData,
  type StorageAdapter,
  STORAGE_KEYS,
  browserStorageAdapter,
  CredentialStorageManager,
  storage,
} from './storage.js'

// =============================================================================
// Token types
// =============================================================================
export { type TokenResult, type PreparedTokenResult } from './tokens.js'

// =============================================================================
// Proof storage (IndexedDB)
// =============================================================================
export { type StoredProof, ProofStorageManager, proofStorage } from './proof-storage.js'

// =============================================================================
// Reference data (kept in sync with the platform's issuance normalisation)
// =============================================================================
export { EU_ALPHA2 } from './eu-countries.js'

// =============================================================================
// Presentation Protocol (ISO 18013-5 style)
// =============================================================================
export {
  type SessionEngagement,
  type PresentationRequest,
  type PresentationResponse,
  type PresentationPredicate,
  type WsMessage,
  type WsMessageType,
  type WsError,
  type PredicateNotSatisfiedPayload,
  type ProofFailedPayload,
  PRESENTATION_PREDICATES,
  encodeSessionEngagement,
  decodeSessionEngagement,
  isPresentationEngagement,
  isCompactToken,
} from './presentation.js'

// =============================================================================
// Proof error parsing (typed errors crossing the native SDK FFI)
// =============================================================================
export {
  type ProofErrorCode,
  type ProofError,
  parseProofError,
  isPredicateNotSatisfied,
} from './proof-errors.js'
