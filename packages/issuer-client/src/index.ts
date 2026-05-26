/**
 * @owlid/issuer-client
 *
 * Customer-facing API client for the OwlID **Issuer Service**. Use this
 * package in any app that needs to start identity-verification sessions,
 * receive issued credentials, or list providers.
 *
 *     import { configure } from '@owlid/config'
 *     import { getSessionsApi, getCredentialsApi } from '@owlid/issuer-client'
 *
 *     configure({ issuerUrl: 'https://issuer.example.com', apiKey })
 *
 *     const session = await getSessionsApi().createSession({
 *       createSessionRequest: { providerId: 'mock-digid' },
 *     })
 *
 * Webhook receivers (the endpoints providers POST back to) are operator-only
 * and live in `@owlid/admin-client`.
 */

import { Configuration } from './runtime.js'
import { apiKeyHeaders, getApiKey, getIssuerUrl } from '@owlid/config'
import {
  CredentialsApi,
  InfoApi,
  PollingApi,
  OidcApi,
  ProvidersApi,
  SessionsApi,
} from './apis/index.js'

export interface IssuerClientOptions {
  basePath?: string
  apiKey?: string
  headers?: Record<string, string>
}

function buildConfig(opts?: IssuerClientOptions): Configuration {
  const apiKey = opts?.apiKey ?? getApiKey()
  return new Configuration({
    basePath: getIssuerUrl(opts?.basePath),
    // Spread order: API-key baseline FIRST, caller's per-call headers
    // LAST so they override. The session-bearer flow (per-session
    // `Authorization: Bearer <session_token>` on `/sessions/{id}/*`)
    // would otherwise be silently clobbered by the global API-key
    // bearer and every protected call would 401 with "Session bearer
    // token mismatch".
    headers: { ...apiKeyHeaders(apiKey), ...opts?.headers },
    // SPA flows that share an admin session with the verification service
    // (e.g. the admin dashboard) need the cookie to ride along on issuer-
    // service calls too. `credentials: 'include'` is required for fetch to
    // attach cookies on cross-origin requests.
    credentials: 'include',
  })
}

let _sessionsApi: SessionsApi | null = null
let _credentialsApi: CredentialsApi | null = null
let _infoApi: InfoApi | null = null
let _providersApi: ProvidersApi | null = null
let _oidcApi: OidcApi | null = null
let _pollingApi: PollingApi | null = null
let _cachedConfig: Configuration | null = null

function sharedConfig(opts?: IssuerClientOptions): Configuration {
  if (_cachedConfig && !opts) return _cachedConfig
  const cfg = buildConfig(opts)
  if (!opts) _cachedConfig = cfg
  return cfg
}

/** Identity verification sessions. */
export function getSessionsApi(opts?: IssuerClientOptions): SessionsApi {
  if (_sessionsApi && !opts) return _sessionsApi
  const api = new SessionsApi(sharedConfig(opts))
  if (!opts) _sessionsApi = api
  return api
}

/** Credential issuance. */
export function getCredentialsApi(opts?: IssuerClientOptions): CredentialsApi {
  if (_credentialsApi && !opts) return _credentialsApi
  const api = new CredentialsApi(sharedConfig(opts))
  if (!opts) _credentialsApi = api
  return api
}

/** Issuer service health and metadata (issuer-info, /health). */
export function getInfoApi(opts?: IssuerClientOptions): InfoApi {
  if (_infoApi && !opts) return _infoApi
  const api = new InfoApi(sharedConfig(opts))
  if (!opts) _infoApi = api
  return api
}

/** List supported identity providers. */
export function getProvidersApi(opts?: IssuerClientOptions): ProvidersApi {
  if (_providersApi && !opts) return _providersApi
  const api = new ProvidersApi(sharedConfig(opts))
  if (!opts) _providersApi = api
  return api
}

/** OIDC login flows. */
export function getOidcApi(opts?: IssuerClientOptions): OidcApi {
  if (_oidcApi && !opts) return _oidcApi
  const api = new OidcApi(sharedConfig(opts))
  if (!opts) _oidcApi = api
  return api
}

/**
 * Session-status polling for QR-based providers (e.g. BankID).
 * Holders call this to wait for a remote authenticator to complete.
 */
export function getPollingApi(opts?: IssuerClientOptions): PollingApi {
  if (_pollingApi && !opts) return _pollingApi
  const api = new PollingApi(sharedConfig(opts))
  if (!opts) _pollingApi = api
  return api
}

export function resetIssuerClient(): void {
  _sessionsApi = null
  _credentialsApi = null
  _infoApi = null
  _providersApi = null
  _oidcApi = null
  _pollingApi = null
  _cachedConfig = null
}

export { CredentialsApi, InfoApi, PollingApi, OidcApi, ProvidersApi, SessionsApi, Configuration }

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
  ProviderDescriptor,
  CallbackResponse,
  PollResponse,
} from './models/index.js'
