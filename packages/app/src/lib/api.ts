/**
 * API Client configuration.
 *
 * Imports generated API classes from SDK subpath exports to avoid
 * circular dependency with the native WASM module in the main barrel.
 */

import {
  Configuration as IssuerConfiguration,
  SessionsApi,
  CredentialsApi,
  InfoApi,
  ProvidersApi,
  InternalApi,
  UtilitiesApi,
} from '@owlid/sdk/api/issuer'

import {
  Configuration as VerificationConfiguration,
  VerificationApi,
  IssuersApi,
  RevocationsApi,
  MonitoringApi,
  GdprApi,
  AdminApi,
} from '@owlid/sdk/api/verification'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ISSUER_URL = import.meta.env.VITE_ISSUER_URL || 'http://localhost:8001'
const VERIFICATION_URL = import.meta.env.VITE_VERIFICATION_URL || 'http://localhost:8000'
const API_KEY = import.meta.env.VITE_API_KEY || ''

const issuerConfig = new IssuerConfiguration({ basePath: ISSUER_URL })
const verificationConfig = new VerificationConfiguration({
  basePath: VERIFICATION_URL,
  headers: API_KEY ? { 'X-API-Key': API_KEY } : undefined,
})

// ---------------------------------------------------------------------------
// Issuer Service clients
// ---------------------------------------------------------------------------

export const sessionsApi = new SessionsApi(issuerConfig)
export const credentialsApi = new CredentialsApi(issuerConfig)
export const infoApi = new InfoApi(issuerConfig)
export const providersApi = new ProvidersApi(issuerConfig)
export const internalApi = new InternalApi(issuerConfig)
export const utilitiesApi = new UtilitiesApi(issuerConfig)

// ---------------------------------------------------------------------------
// Verification Service clients
// ---------------------------------------------------------------------------

export const verificationApi = new VerificationApi(verificationConfig)
export const issuersApi = new IssuersApi(verificationConfig)
export const revocationsApi = new RevocationsApi(verificationConfig)
export const monitoringApi = new MonitoringApi(verificationConfig)
export const gdprApi = new GdprApi(verificationConfig)
export const adminApi = new AdminApi(verificationConfig)

// ---------------------------------------------------------------------------
// URLs for WebSocket connections
// ---------------------------------------------------------------------------

export { ISSUER_URL, VERIFICATION_URL }
