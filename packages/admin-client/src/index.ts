/**
 * @owlid/admin-client
 *
 * **Operator-only** API client. Wraps every admin endpoint of the
 * Verification + Issuer services: admin auth, API-key management, GDPR
 * erasure, manage-issuers, manage-revocations, detailed metrics, and
 * provider webhook callbacks.
 *
 * Do NOT bundle this into customer-facing apps. It exists for the OwlID
 * admin dashboard and operator tooling only — every endpoint requires an
 * admin-permission API key (or an admin JWT) on the backend, but exposing
 * the surface to customers leaks the operational topology.
 */

import {
  AdminApi,
  AdminAuthApi,
  AdminIssuersApi,
  AdminRevocationsApi,
  GdprApi,
  MetricsApi,
} from './verification/apis/index.js'
import { AdminApi as IssuerAdminApi, CallbacksApi } from './issuer/apis/index.js'
import { Configuration as VerificationConfiguration } from './verification/runtime.js'
import { Configuration as IssuerConfiguration } from './issuer/runtime.js'
import { apiKeyHeaders, getApiKey, getIssuerUrl, getVerificationUrl } from '@owlid/config'

export interface AdminClientOptions {
  basePath?: string
  apiKey?: string
  headers?: Record<string, string>
}

function buildHeaders(opts?: AdminClientOptions): Record<string, string> {
  const apiKey = opts?.apiKey ?? getApiKey()
  return { ...opts?.headers, ...apiKeyHeaders(apiKey) }
}

let _verificationConfig: VerificationConfiguration | null = null
let _issuerConfig: IssuerConfiguration | null = null

function verificationConfig(opts?: AdminClientOptions): VerificationConfiguration {
  if (_verificationConfig && !opts) return _verificationConfig
  const cfg = new VerificationConfiguration({
    basePath: getVerificationUrl(opts?.basePath),
    headers: buildHeaders(opts),
    credentials: 'include',
  })
  if (!opts) _verificationConfig = cfg
  return cfg
}

function issuerConfig(opts?: AdminClientOptions): IssuerConfiguration {
  if (_issuerConfig && !opts) return _issuerConfig
  const cfg = new IssuerConfiguration({
    basePath: getIssuerUrl(opts?.basePath),
    headers: buildHeaders(opts),
    credentials: 'include',
  })
  if (!opts) _issuerConfig = cfg
  return cfg
}

let _adminApi: AdminApi | null = null
let _adminAuthApi: AdminAuthApi | null = null
let _adminIssuersApi: AdminIssuersApi | null = null
let _adminRevocationsApi: AdminRevocationsApi | null = null
let _gdprApi: GdprApi | null = null
let _metricsApi: MetricsApi | null = null
let _callbacksApi: CallbacksApi | null = null

export function getAdminApi(opts?: AdminClientOptions): AdminApi {
  if (_adminApi && !opts) return _adminApi
  const api = new AdminApi(verificationConfig(opts))
  if (!opts) _adminApi = api
  return api
}

export function getAdminAuthApi(opts?: AdminClientOptions): AdminAuthApi {
  if (_adminAuthApi && !opts) return _adminAuthApi
  const api = new AdminAuthApi(verificationConfig(opts))
  if (!opts) _adminAuthApi = api
  return api
}

/** Manage trusted issuers (add). */
export function getAdminIssuersApi(opts?: AdminClientOptions): AdminIssuersApi {
  if (_adminIssuersApi && !opts) return _adminIssuersApi
  const api = new AdminIssuersApi(verificationConfig(opts))
  if (!opts) _adminIssuersApi = api
  return api
}

/** Manage credential revocations (revoke/suspend/reactivate). */
export function getAdminRevocationsApi(opts?: AdminClientOptions): AdminRevocationsApi {
  if (_adminRevocationsApi && !opts) return _adminRevocationsApi
  const api = new AdminRevocationsApi(verificationConfig(opts))
  if (!opts) _adminRevocationsApi = api
  return api
}

/** GDPR right-to-be-forgotten. */
export function getGdprApi(opts?: AdminClientOptions): GdprApi {
  if (_gdprApi && !opts) return _gdprApi
  const api = new GdprApi(verificationConfig(opts))
  if (!opts) _gdprApi = api
  return api
}

/** Detailed service metrics (admin-gated). Use the public health probe in `@owlid/verifier-client` for liveness. */
export function getMetricsApi(opts?: AdminClientOptions): MetricsApi {
  if (_metricsApi && !opts) return _metricsApi
  const api = new MetricsApi(verificationConfig(opts))
  if (!opts) _metricsApi = api
  return api
}

/** Provider webhook receivers (server-receives, only useful for inspection). */
export function getCallbacksApi(opts?: AdminClientOptions): CallbacksApi {
  if (_callbacksApi && !opts) return _callbacksApi
  const api = new CallbacksApi(issuerConfig(opts))
  if (!opts) _callbacksApi = api
  return api
}

let _issuerAdminApi: IssuerAdminApi | null = null

/** Issuer-side admin endpoints — provider enable/disable. */
export function getIssuerAdminApi(opts?: AdminClientOptions): IssuerAdminApi {
  if (_issuerAdminApi && !opts) return _issuerAdminApi
  const api = new IssuerAdminApi(issuerConfig(opts))
  if (!opts) _issuerAdminApi = api
  return api
}

export function resetAdminClient(): void {
  _adminApi = null
  _adminAuthApi = null
  _adminIssuersApi = null
  _adminRevocationsApi = null
  _gdprApi = null
  _metricsApi = null
  _callbacksApi = null
  _issuerAdminApi = null
  _verificationConfig = null
  _issuerConfig = null
}

export {
  AdminApi,
  AdminAuthApi,
  AdminIssuersApi,
  AdminRevocationsApi,
  GdprApi,
  MetricsApi,
  CallbacksApi,
  IssuerAdminApi,
  VerificationConfiguration,
  IssuerConfiguration,
}

export { ResponseError } from './verification/runtime.js'

export type {
  AddTrustedIssuerRequest,
  AddTrustedIssuerResponse,
  RevokeCredentialRequest,
  ReactivateCredentialRequest,
  ErasureReceipt,
  LoginRequest,
  LoginResponse,
  MeResponse,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  ApiKeyInfo,
  ChangePasswordRequest,
  ChangePasswordResponse,
  MidnightStatus,
  SidecarHealth,
  ToggleResponse,
  MetricsResponse,
} from './verification/models/index.js'

export type { ProviderToggleResponse } from './issuer/models/index.js'

export { KeyType, Environment } from './verification/models/index.js'
