/**
 * @owlid/verifier-client
 *
 * Customer-facing API client for the OwlID **Verification Service**. Use this
 * package in any app that needs to verify tokens, run the verifier-side
 * presentation protocol (QR scan → WebSocket → token), check public
 * revocation status, or list trusted issuers.
 *
 * Configure once at app startup via `configure()` from `@owlid/config`:
 *
 *     import { configure } from '@owlid/config'
 *     import { getVerificationApi } from '@owlid/verifier-client'
 *
 *     configure({ verificationUrl: 'https://api.example.com', apiKey })
 *
 *     const result = await getVerificationApi().verifyToken({
 *       verifyRequest: { token, challenge },
 *     })
 *
 * Operator-only endpoints (admin auth, GDPR erasure, manage-issuers,
 * manage-revocations, detailed metrics) live in `@owlid/admin-client`.
 */

import { Configuration } from './runtime.js'
import { apiKeyHeaders, getApiKey, getVerificationUrl } from '@owlid/config'
import {
  IssuersApi,
  MonitoringApi,
  PresentationApi,
  RegistryApi,
  RevocationsApi,
  VerificationApi,
} from './apis/index.js'

export interface VerifierClientOptions {
  basePath?: string
  apiKey?: string
  headers?: Record<string, string>
}

function buildConfig(opts?: VerifierClientOptions): Configuration {
  const apiKey = opts?.apiKey ?? getApiKey()
  return new Configuration({
    basePath: getVerificationUrl(opts?.basePath),
    headers: { ...opts?.headers, ...apiKeyHeaders(apiKey) },
    // Send the admin session cookie (`owlid_admin_token`) when the SPA is
    // logged in. The verification service accepts either an API key
    // (Authorization header) or an admin session cookie. Setting
    // `credentials: 'include'` is required for the cookie to cross
    // origins in fetch; the backend's CORS layer already has
    // `allow_credentials(true)` with an explicit origin allowlist.
    credentials: 'include',
  })
}

let _verificationApi: VerificationApi | null = null
let _presentationApi: PresentationApi | null = null
let _issuersApi: IssuersApi | null = null
let _monitoringApi: MonitoringApi | null = null
let _revocationsApi: RevocationsApi | null = null
let _registryApi: RegistryApi | null = null
let _cachedConfig: Configuration | null = null

function sharedConfig(opts?: VerifierClientOptions): Configuration {
  if (_cachedConfig && !opts) return _cachedConfig
  const cfg = buildConfig(opts)
  if (!opts) _cachedConfig = cfg
  return cfg
}

/** Token verification: verifyToken, generateChallenge. */
export function getVerificationApi(opts?: VerifierClientOptions): VerificationApi {
  if (_verificationApi && !opts) return _verificationApi
  const api = new VerificationApi(sharedConfig(opts))
  if (!opts) _verificationApi = api
  return api
}

/** Presentation sessions for the QR flow: createPresentationSession. */
export function getPresentationApi(opts?: VerifierClientOptions): PresentationApi {
  if (_presentationApi && !opts) return _presentationApi
  const api = new PresentationApi(sharedConfig(opts))
  if (!opts) _presentationApi = api
  return api
}

/** Trusted-issuer directory (read-only): listTrustedIssuers. */
export function getIssuersApi(opts?: VerifierClientOptions): IssuersApi {
  if (_issuersApi && !opts) return _issuersApi
  const api = new IssuersApi(sharedConfig(opts))
  if (!opts) _issuersApi = api
  return api
}

/** Public health probe. */
export function getMonitoringApi(opts?: VerifierClientOptions): MonitoringApi {
  if (_monitoringApi && !opts) return _monitoringApi
  const api = new MonitoringApi(sharedConfig(opts))
  if (!opts) _monitoringApi = api
  return api
}

/** Revocation lookups (read-only): checkRevocation, listRevoked. */
export function getRevocationsApi(opts?: VerifierClientOptions): RevocationsApi {
  if (_revocationsApi && !opts) return _revocationsApi
  const api = new RevocationsApi(sharedConfig(opts))
  if (!opts) _revocationsApi = api
  return api
}

/**
 * Predicate + circuit-dataset registry (public reference data, no auth):
 * listPredicates, listCircuitData, getCircuitDataset.
 */
export function getRegistryApi(opts?: VerifierClientOptions): RegistryApi {
  if (_registryApi && !opts) return _registryApi
  const api = new RegistryApi(sharedConfig(opts))
  if (!opts) _registryApi = api
  return api
}

/** Drop cached singletons (useful in tests after reconfiguring). */
export function resetVerifierClient(): void {
  _verificationApi = null
  _presentationApi = null
  _issuersApi = null
  _monitoringApi = null
  _revocationsApi = null
  _registryApi = null
  _cachedConfig = null
}

export {
  Configuration,
  IssuersApi,
  MonitoringApi,
  PresentationApi,
  RegistryApi,
  RevocationsApi,
  VerificationApi,
}

export type {
  VerifyRequest,
  VerifyResponse,
  ChallengeResponse,
  CheckRevocationRequest,
  CheckRevocationResponse,
  CreatePresentationResponse,
  TrustedIssuerInfo,
  PredicateInfo,
  CircuitDataset,
  CircuitDatasetInfo,
  RevocationEntry,
} from './models/index.js'
