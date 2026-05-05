/**
 * API Client Singletons
 *
 * One singleton per generated API class, lazily created on first access.
 * Configured from VITE_* env vars or explicit options.
 *
 * Usage:
 *   import { getVerificationApi, getSessionsApi, getCredentialsApi } from '@owlid/sdk'
 *
 *   const result = await getVerificationApi().verifyToken({ verifyRequest: { token, challenge } })
 *   const session = await getSessionsApi().createSession({ createSessionRequest: { providerId: 'mock-digid' } })
 *   const cred = await getCredentialsApi().issueCredential({ id, issueCredentialRequest: { ... } })
 */

// Verification service classes
import {
  Configuration as VerificationConfig,
  VerificationApi,
  IssuersApi,
  RevocationsApi,
  MonitoringApi,
  GdprApi,
  AdminApi,
} from './generated/verification/index.js'

// Issuer service classes
import {
  Configuration as IssuerConfig,
  SessionsApi,
  CredentialsApi,
  InfoApi,
  ProvidersApi,
  OidcApi,
  CallbacksApi,
  InternalApi,
  UtilitiesApi,
} from './generated/issuer/index.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ApiClientOptions {
  basePath: string
  apiKey?: string
  headers?: Record<string, string>
}

function resolveEnv(name: string): string | undefined {
  if (typeof import.meta !== 'undefined') {
    return (import.meta as any).env?.[name]
  }
  if (typeof process !== 'undefined') {
    return process.env?.[name]
  }
  return undefined
}

function verificationBasePath(opts?: Partial<ApiClientOptions>): string {
  return opts?.basePath ?? resolveEnv('VITE_VERIFICATION_URL') ?? 'http://localhost:8000'
}

function issuerBasePath(opts?: Partial<ApiClientOptions>): string {
  return opts?.basePath ?? resolveEnv('VITE_ISSUER_URL') ?? 'http://localhost:8001'
}

function buildHeaders(opts?: Partial<ApiClientOptions>): Record<string, string> {
  const h: Record<string, string> = { ...opts?.headers }
  const key = opts?.apiKey ?? resolveEnv('VITE_API_KEY')
  if (key) h['X-API-Key'] = key
  return h
}

// ---------------------------------------------------------------------------
// Cached configs (one per service)
// ---------------------------------------------------------------------------

let _verificationConfig: VerificationConfig | null = null
let _issuerConfig: IssuerConfig | null = null

function getVerificationConfig(opts?: Partial<ApiClientOptions>): VerificationConfig {
  if (_verificationConfig && !opts) return _verificationConfig
  const cfg = new VerificationConfig({
    basePath: verificationBasePath(opts),
    headers: buildHeaders(opts),
  })
  if (!opts) _verificationConfig = cfg
  return cfg
}

function getIssuerConfig(opts?: Partial<ApiClientOptions>): IssuerConfig {
  if (_issuerConfig && !opts) return _issuerConfig
  const cfg = new IssuerConfig({
    basePath: issuerBasePath(opts),
    headers: buildHeaders(opts),
  })
  if (!opts) _issuerConfig = cfg
  return cfg
}

// ---------------------------------------------------------------------------
// Verification Service singletons
// ---------------------------------------------------------------------------

let _verificationApi: VerificationApi | null = null
let _issuersApi: IssuersApi | null = null
let _revocationsApi: RevocationsApi | null = null
let _monitoringApi: MonitoringApi | null = null
let _gdprApi: GdprApi | null = null

/** Token verification: verifyToken */
export function getVerificationApi(opts?: Partial<ApiClientOptions>): VerificationApi {
  if (_verificationApi && !opts) return _verificationApi
  const api = new VerificationApi(getVerificationConfig(opts))
  if (!opts) _verificationApi = api
  return api
}

/** Trusted issuer management: addTrustedIssuer, listTrustedIssuers */
export function getIssuersApi(opts?: Partial<ApiClientOptions>): IssuersApi {
  if (_issuersApi && !opts) return _issuersApi
  const api = new IssuersApi(getVerificationConfig(opts))
  if (!opts) _issuersApi = api
  return api
}

/** Credential revocation: revokeCredential, suspendCredential, reactivateCredential, checkRevocation, listRevoked */
export function getRevocationsApi(opts?: Partial<ApiClientOptions>): RevocationsApi {
  if (_revocationsApi && !opts) return _revocationsApi
  const api = new RevocationsApi(getVerificationConfig(opts))
  if (!opts) _revocationsApi = api
  return api
}

/** Service monitoring: health, getMetrics */
export function getMonitoringApi(opts?: Partial<ApiClientOptions>): MonitoringApi {
  if (_monitoringApi && !opts) return _monitoringApi
  const api = new MonitoringApi(getVerificationConfig(opts))
  if (!opts) _monitoringApi = api
  return api
}

/** GDPR compliance: gdprErasure */
export function getGdprApi(opts?: Partial<ApiClientOptions>): GdprApi {
  if (_gdprApi && !opts) return _gdprApi
  const api = new GdprApi(getVerificationConfig(opts))
  if (!opts) _gdprApi = api
  return api
}

let _adminApi: AdminApi | null = null

/** Admin auth and API key management: login, listApiKeys, createApiKey, deactivateApiKey */
export function getAdminApi(opts?: Partial<ApiClientOptions>): AdminApi {
  if (_adminApi && !opts) return _adminApi
  const api = new AdminApi(getVerificationConfig(opts))
  if (!opts) _adminApi = api
  return api
}

// ---------------------------------------------------------------------------
// Issuer Service singletons
// ---------------------------------------------------------------------------

let _sessionsApi: SessionsApi | null = null
let _credentialsApi: CredentialsApi | null = null
let _infoApi: InfoApi | null = null
let _providersApi: ProvidersApi | null = null
let _oidcApi: OidcApi | null = null
let _callbacksApi: CallbacksApi | null = null
let _internalApi: InternalApi | null = null
let _utilitiesApi: UtilitiesApi | null = null

/** Session management: createSession, getSession, submitIdentity, getClaims, autoVerify, completeVerification */
export function getSessionsApi(opts?: Partial<ApiClientOptions>): SessionsApi {
  if (_sessionsApi && !opts) return _sessionsApi
  const api = new SessionsApi(getIssuerConfig(opts))
  if (!opts) _sessionsApi = api
  return api
}

/** Credential issuance: issueCredential */
export function getCredentialsApi(opts?: Partial<ApiClientOptions>): CredentialsApi {
  if (_credentialsApi && !opts) return _credentialsApi
  const api = new CredentialsApi(getIssuerConfig(opts))
  if (!opts) _credentialsApi = api
  return api
}

/** Service info: getIssuerInfo, health */
export function getInfoApi(opts?: Partial<ApiClientOptions>): InfoApi {
  if (_infoApi && !opts) return _infoApi
  const api = new InfoApi(getIssuerConfig(opts))
  if (!opts) _infoApi = api
  return api
}

/** Identity providers: listProviders */
export function getProvidersApi(opts?: Partial<ApiClientOptions>): ProvidersApi {
  if (_providersApi && !opts) return _providersApi
  const api = new ProvidersApi(getIssuerConfig(opts))
  if (!opts) _providersApi = api
  return api
}

/** OIDC flows: oidcLogin, oidcCallback, listOidcProviders */
export function getOidcApi(opts?: Partial<ApiClientOptions>): OidcApi {
  if (_oidcApi && !opts) return _oidcApi
  const api = new OidcApi(getIssuerConfig(opts))
  if (!opts) _oidcApi = api
  return api
}

/** Provider callbacks: handleSamlCallback, handleWebhook */
export function getCallbacksApi(opts?: Partial<ApiClientOptions>): CallbacksApi {
  if (_callbacksApi && !opts) return _callbacksApi
  const api = new CallbacksApi(getIssuerConfig(opts))
  if (!opts) _callbacksApi = api
  return api
}

/** Internal polling: pollSession */
export function getInternalApi(opts?: Partial<ApiClientOptions>): InternalApi {
  if (_internalApi && !opts) return _internalApi
  const api = new InternalApi(getIssuerConfig(opts))
  if (!opts) _internalApi = api
  return api
}

/** Utilities: generateKeypair */
export function getUtilitiesApi(opts?: Partial<ApiClientOptions>): UtilitiesApi {
  if (_utilitiesApi && !opts) return _utilitiesApi
  const api = new UtilitiesApi(getIssuerConfig(opts))
  if (!opts) _utilitiesApi = api
  return api
}

// ---------------------------------------------------------------------------
// Reset all singletons (for testing)
// ---------------------------------------------------------------------------

export function resetApiClients(): void {
  _verificationConfig = null
  _issuerConfig = null
  _verificationApi = null
  _issuersApi = null
  _revocationsApi = null
  _monitoringApi = null
  _gdprApi = null
  _adminApi = null
  _sessionsApi = null
  _credentialsApi = null
  _infoApi = null
  _providersApi = null
  _oidcApi = null
  _callbacksApi = null
  _internalApi = null
  _utilitiesApi = null
}
