/**
 * API client surface used by the holder app.
 *
 * Routes through the public verifier + issuer client packages. Admin/operator
 * endpoints (manage-issuers, manage-revocations, GDPR erasure, API key mgmt)
 * are deliberately NOT bundled here — those live in `@owlid/admin-client`
 * and only the admin dashboard imports them.
 */

import { getIssuerUrl, getVerificationUrl } from '@owlid/sdk'
import { getCredentialsApi, getInfoApi, getProvidersApi, getSessionsApi } from '@owlid/sdk/issuer'
import { getRegistryApi, getVerificationApi } from '@owlid/sdk/verifier'

// API getters resolve URLs/keys via the shared SDK config; no extra wiring.
export const sessionsApi = getSessionsApi()
export const credentialsApi = getCredentialsApi()
export const infoApi = getInfoApi()
export const providersApi = getProvidersApi()
export const verificationApi = getVerificationApi()
// Predicate + circuit-data registry lives on the verification service.
export const registryApi = getRegistryApi()

// Convenience exports for code that constructs URLs (e.g. WebSocket open).
export const ISSUER_URL = getIssuerUrl()
export const VERIFICATION_URL = getVerificationUrl()
