/**
 * Re-export SDK API singletons for the admin dashboard.
 *
 * All configuration (base URLs, API key) is resolved from VITE_* env vars
 * by the SDK's api-client module. No local wrappers needed.
 */
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
  getInfoApi,
  getProvidersApi,
  getOidcApi,
} from '@owlid/sdk'
