/**
 * @owlid/sdk
 *
 * Complete OwlID SDK with WebAuthn, cryptography, and native bindings.
 * Can be used with or without React.
 */

// =============================================================================
// Re-export from Native SDK (Rust/WASM cryptographic primitives)
// =============================================================================
export {
  // Classes
  Document,
  KeyPair,
  PreparedToken,
  Credential,
  PublicKey,
  Signature,
  Token,
  // Functions
  blake3,
  sha256,
  // Types
  type ProofRequest,
  type PredicateRequest,
  type WebAuthnSignatureData,
} from '@owlid/native-sdk'

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
  // Types
  type WebAuthnSignatureResult,
  type WebAuthnRegistrationResult,
  type WebAuthnRegistrationOptions,
  type WebAuthnAuthenticationOptions,
  // CBOR/COSE parsing
  extractPublicKeyFromAttestation,
  coseKeyToP256Hex,
  parseCoseKey,
  // WebAuthn operations
  registerCredential,
  signChallenge,
  authenticate,
  // Utilities
  isWebAuthnSupported,
  isPlatformAuthenticatorAvailable,
} from './webauthn.js'

// =============================================================================
// Storage
// =============================================================================
export {
  // Types
  type StoredWebAuthnCredential,
  type StoredCredentialData,
  type Credential as StoredCredential,
  type VerifiedClaims,
  type IdentityData,
  type StorageAdapter,
  // Constants
  STORAGE_KEYS,
  // Adapters
  browserStorageAdapter,
  // Storage manager
  CredentialStorageManager,
  storage,
} from './storage.js'

// =============================================================================
// Token types
// =============================================================================
export {
  // Types
  type TokenResult,
  type PreparedTokenResult,
} from './tokens.js'

// =============================================================================
// Proof storage (IndexedDB)
// =============================================================================
export {
  // Types
  type StoredProof,
  // Storage manager
  ProofStorageManager,
  proofStorage,
} from './proof-storage.js'

// =============================================================================
// Presentation Protocol (ISO 18013-5 style)
// =============================================================================
export {
  // Types
  type SessionEngagement,
  type PresentationRequest,
  type PresentationResponse,
  type PresentationPredicate,
  type WsMessage,
  type WsMessageType,
  type WsError,
  // Constants
  PRESENTATION_PREDICATES,
  // Functions
  encodeSessionEngagement,
  decodeSessionEngagement,
  isPresentationEngagement,
  isCompactToken,
} from './presentation.js'

// =============================================================================
// Generated API Clients (from OpenAPI specs)
// =============================================================================
export {
  // Verification Service classes
  VerificationApi,
  IssuersApi,
  RevocationsApi,
  MonitoringApi,
  GdprApi,
  AdminApi,
  VerificationConfiguration,
  // Issuer Service classes
  SessionsApi,
  CredentialsApi,
  InfoApi,
  ProvidersApi,
  OidcApi,
  CallbacksApi,
  InternalApi,
  UtilitiesApi,
  IssuerConfiguration,
  // Verification types
  type VerifyRequest,
  type VerifyResponse,
  type AddTrustedIssuerRequest,
  type AddTrustedIssuerResponse,
  type TrustedIssuerInfo,
  type RevokeCredentialRequest,
  type ReactivateCredentialRequest,
  type CheckRevocationRequest,
  type CheckRevocationResponse,
  type ErasureReceipt,
  type LoginRequest,
  type LoginResponse,
  type CreateApiKeyRequest,
  type CreateApiKeyResponse,
  type ApiKeyInfo,
  // Issuer types
  type CreateSessionRequest,
  type CreateSessionResponse,
  type SessionResponse,
  type IssueCredentialRequest,
  type IssueCredentialResponse,
  type CompleteVerificationResponse,
  type VerificationWarningResponse,
  type IssuerInfoResponse,
  type OidcProviderInfo,
  type OidcLoginResponse,
  type OidcCallbackResponse,
  type OidcCallbackQuery,
  type FlowState,
  type SessionStatus,
  type VerificationLevel,
  type VerifiedIdentityClaims,
  type IdentitySubmissionForm,
  type ProviderFlowType,
  type VerificationStart,
  type FormConfig,
  type FormField,
  type FormFieldType,
  type ProviderInfo,
  type ProviderInfoExtended,
  type CallbackResponse,
  type PollResponse,
  type KeyPairResponse,
} from './generated/index.js'

// =============================================================================
// API Client Singletons
// =============================================================================
export {
  // Verification service
  getVerificationApi,
  getIssuersApi,
  getRevocationsApi,
  getMonitoringApi,
  getGdprApi,
  getAdminApi,
  // Issuer service
  getSessionsApi,
  getCredentialsApi,
  getInfoApi,
  getProvidersApi,
  getOidcApi,
  getCallbacksApi,
  getInternalApi,
  getUtilitiesApi,
  // Utilities
  resetApiClients,
  type ApiClientOptions,
} from './api-client.js'
