/**
 * Re-export API client singletons used by the admin dashboard.
 *
 * Public read surfaces come from `@owlid/{verifier,issuer}-client`.
 * Operator-only endpoints (admin auth, GDPR, manage-issuers,
 * manage-revocations, detailed metrics) come from `@owlid/admin-client`.
 *
 * Configuration (URLs, API key) is resolved by `@owlid/config`'s
 * `configure()` — admin doesn't depend on `@owlid/sdk`, which carries the
 * native bindings + WASM the dashboard never needs.
 */
export {
  getAdminApi,
  getAdminIssuersApi,
  getAdminRevocationsApi,
  getGdprApi,
  getMetricsApi,
} from '@owlid/admin-client'

export {
  getIssuersApi,
  getMonitoringApi,
  getRevocationsApi,
  getVerificationApi,
} from '@owlid/verifier-client'

export { getInfoApi, getOidcApi, getProvidersApi, getSessionsApi } from '@owlid/issuer-client'
