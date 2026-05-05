/**
 * Auto-generated API clients from OpenAPI specs.
 *
 * Verification Service (port 8000): Token verification, issuer management, revocations, GDPR
 * Issuer Service (port 8001): Sessions, credentials, providers, OIDC, callbacks
 *
 * Regenerate: just generate-api-client
 */

// Verification Service — all API classes
export {
  VerificationApi,
  IssuersApi,
  RevocationsApi,
  MonitoringApi,
  GdprApi,
  AdminApi,
  Configuration as VerificationConfiguration,
} from './verification/index.js'

// Verification Service — all types
export type {
  VerifyRequest,
  VerifyResponse,
  AddTrustedIssuerRequest,
  AddTrustedIssuerResponse,
  TrustedIssuerInfo,
  RevokeCredentialRequest,
  ReactivateCredentialRequest,
  CheckRevocationRequest,
  CheckRevocationResponse,
  ErasureReceipt,
  LoginRequest,
  LoginResponse,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  ApiKeyInfo,
} from './verification/index.js'

// Issuer Service — all API classes
export {
  SessionsApi,
  CredentialsApi,
  InfoApi,
  ProvidersApi,
  OidcApi,
  CallbacksApi,
  InternalApi,
  UtilitiesApi,
  Configuration as IssuerConfiguration,
} from './issuer/index.js'

// Issuer Service — all types
export type {
  CreateSessionRequest,
  CreateSessionResponse,
  SessionResponse,
  IssueCredentialRequest,
  IssueCredentialResponse,
  CompleteVerificationResponse,
  VerificationWarningResponse,
  IssuerInfoResponse,
  OidcProviderInfo,
  OidcLoginResponse,
  OidcCallbackResponse,
  OidcCallbackQuery,
  // Complete types from the spec
  FlowState,
  SessionStatus,
  VerificationLevel,
  VerifiedIdentityClaims,
  IdentitySubmissionForm,
  ProviderFlowType,
  VerificationStart,
  FormConfig,
  FormField,
  FormFieldType,
  ProviderInfo,
  ProviderInfoExtended,
  CallbackResponse,
  PollResponse,
  KeyPairResponse,
} from './issuer/index.js'
