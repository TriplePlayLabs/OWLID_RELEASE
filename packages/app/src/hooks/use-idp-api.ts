/**
 * TanStack Query hooks for Issuer API calls
 *
 * Clean separation of API state management using React Query.
 * Uses WebAuthn for hardware-backed security - no private keys stored.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  coseKeyToP256Hex,
  storage,
  type StoredCredentialData,
  type StoredCredential,
} from '@owlid/sdk'
import type { ProviderInfoExtended, CreateSessionResponse } from '@owlid/sdk/issuer'

// The providers endpoint returns ProviderInfoExtended
type ProviderInfo = ProviderInfoExtended
import { providersApi, sessionsApi, credentialsApi, infoApi } from '~/lib/api'

const PENDING_SESSION_KEY = 'owl_pending_session'
const PENDING_SESSION_TOKEN_KEY = 'owl_pending_session_token'

function bearerInit(token: string): RequestInit {
  return { headers: { Authorization: `Bearer ${token}` } }
}

/**
 * Extract issuer public key from credential
 */
function extractIssuerPublicKey(credential: StoredCredential): string {
  const attributes = credential.attributes as Record<string, unknown> | undefined
  if (attributes?.issuerKey) {
    return attributes.issuerKey as string
  }
  if (credential.issuerPublicKey) {
    return credential.issuerPublicKey as string
  }
  const issuerPubKey = credential['issuer_public_key']
  if (typeof issuerPubKey === 'string') {
    return issuerPubKey
  }
  return ''
}

/** Sentinel error thrown when the user is being redirected to an external provider. Not a real failure. */
export class RedirectingToProviderError extends Error {
  constructor() {
    super('Redirecting to provider...')
    this.name = 'RedirectingToProviderError'
  }
}

// Query keys
export const issuerQueryKeys = {
  all: ['issuer'] as const,
  providers: () => [...issuerQueryKeys.all, 'providers'] as const,
  session: (sessionId: string) => [...issuerQueryKeys.all, 'session', sessionId] as const,
  claims: (sessionId: string) => [...issuerQueryKeys.all, 'claims', sessionId] as const,
  health: () => [...issuerQueryKeys.all, 'health'] as const,
}

/**
 * Fetch available identity providers
 */
export function useProviders() {
  return useQuery<ProviderInfo[], Error>({
    queryKey: issuerQueryKeys.providers(),
    queryFn: () => providersApi.listProviders(),
  })
}

/**
 * Check IDP service health
 */
export function useIdpHealth() {
  return useQuery<string, Error>({
    queryKey: issuerQueryKeys.health(),
    queryFn: () => infoApi.health(),
    retry: 1,
    staleTime: 30 * 1000,
  })
}

/**
 * Create a new verification session
 */
export function useCreateSession() {
  const queryClient = useQueryClient()

  return useMutation<CreateSessionResponse, Error, string>({
    mutationFn: (providerId: string) =>
      sessionsApi.createSession({ createSessionRequest: { providerId } }),
    onSuccess: (data) => {
      queryClient.setQueryData(issuerQueryKeys.session(data.sessionId), data)
    },
  })
}

/**
 * WebAuthn-enabled verification flow
 * Uses hardware-backed P-256 keys from secure enclave
 *
 * Handles all provider flow types:
 * - form_based (mock): auto-verify with sample data
 * - webhook_async (Didit): redirect to external provider
 * - saml_redirect: redirect to external provider
 * - qr_polling: start polling flow
 *
 * Flow: session -> verify (based on flow type) -> reuse existing WebAuthn -> issue
 */
export function useVerifyAndIssueWithWebAuthn() {
  return useMutation<StoredCredentialData, Error, { providerId: string; username: string }>({
    onSuccess: (data) => {
      // Don't process redirect sentinels
      if ('redirected' in data) return
    },
    mutationFn: async ({ providerId }) => {
      // Step 1: Get existing WebAuthn credential (created during registration)
      const existingWebAuthn = await storage.loadWebAuthnCredential()
      if (!existingWebAuthn) {
        throw new Error('No WebAuthn credential found. Please register first.')
      }

      // Step 2: Create session
      const session = await sessionsApi.createSession({
        createSessionRequest: { providerId },
      })
      const sessionAuth = bearerInit(session.sessionToken)

      // Step 3: Handle verification based on flow type
      let claims
      const flowType = session.flowType

      if (flowType === 'webhook_async' || flowType === 'saml_redirect') {
        // Redirect flows - redirect to external provider
        const redirectUrl = session.url
        if (!redirectUrl) {
          throw new Error('No redirect URL provided by provider')
        }

        // Store session info + bearer for the post-redirect callback page.
        sessionStorage.setItem(PENDING_SESSION_KEY, session.sessionId)
        sessionStorage.setItem(PENDING_SESSION_TOKEN_KEY, session.sessionToken)

        // Redirect - this will navigate away from the page
        window.location.href = redirectUrl

        // Return a sentinel that indicates redirect happened (not an error)
        return { redirected: true } as unknown as StoredCredentialData
      } else {
        // Form-based (mock) providers - auto-verify
        claims = await sessionsApi.autoVerify({ id: session.sessionId }, sessionAuth)
      }

      // Step 4: Convert existing COSE public key to P-256 hex for credential issuance
      const ownerPublicKeyHex = coseKeyToP256Hex(existingWebAuthn.publicKey)

      // Step 5: Issue credential with P-256 owner public key
      const issueResponse = await credentialsApi.issueCredential(
        {
          id: session.sessionId,
          issueCredentialRequest: { ownerPublicKey: ownerPublicKeyHex, keyAlgorithm: 'p256' },
        },
        sessionAuth,
      )

      if (!issueResponse.success) {
        throw new Error(issueResponse.error || 'Failed to issue credential')
      }

      // Step 6: Build and save credential data
      const credentialData: StoredCredentialData = {
        credential: issueResponse.credential,
        ownerPublicKey: ownerPublicKeyHex,
        webauthnCredentialId: existingWebAuthn.credentialId,
        issuerPublicKey: extractIssuerPublicKey(issueResponse.credential),
        verifiedClaims: claims,
        sessionId: session.sessionId,
        issuedAt: new Date().toISOString(),
      }

      await storage.saveCredentialData(credentialData)

      return credentialData
    },
  })
}

/**
 * Complete credential issuance after redirect callback
 * Called from callback route after external provider verification
 */
export function useCompleteVerificationAfterCallback() {
  return useMutation<StoredCredentialData, Error, { sessionId: string }>({
    mutationFn: async ({ sessionId }) => {
      const sessionToken = sessionStorage.getItem(PENDING_SESSION_TOKEN_KEY) ?? ''
      sessionStorage.removeItem(PENDING_SESSION_KEY)
      sessionStorage.removeItem(PENDING_SESSION_TOKEN_KEY)
      if (!sessionToken) {
        throw new Error('Pending session token missing — open the flow again from /create-identity')
      }
      const sessionAuth = bearerInit(sessionToken)

      // Step 1: Get existing WebAuthn credential (created during registration)
      const existingWebAuthn = await storage.loadWebAuthnCredential()
      if (!existingWebAuthn) {
        throw new Error('No WebAuthn credential found. Please register first.')
      }

      // Step 2: Fetch claims from completed verification
      const claims = await sessionsApi.getClaims({ id: sessionId }, sessionAuth)

      // Step 3: Convert existing COSE public key to P-256 hex for credential issuance
      const ownerPublicKeyHex = coseKeyToP256Hex(existingWebAuthn.publicKey)

      // Step 4: Issue credential with P-256 owner public key
      const issueResponse = await credentialsApi.issueCredential(
        {
          id: sessionId,
          issueCredentialRequest: { ownerPublicKey: ownerPublicKeyHex, keyAlgorithm: 'p256' },
        },
        sessionAuth,
      )

      if (!issueResponse.success) {
        throw new Error(issueResponse.error || 'Failed to issue credential')
      }

      // Step 5: Build and save credential data
      const credentialData: StoredCredentialData = {
        credential: issueResponse.credential,
        ownerPublicKey: ownerPublicKeyHex,
        webauthnCredentialId: existingWebAuthn.credentialId,
        issuerPublicKey: extractIssuerPublicKey(issueResponse.credential),
        verifiedClaims: claims,
        sessionId: sessionId,
        issuedAt: new Date().toISOString(),
      }

      await storage.saveCredentialData(credentialData)

      return credentialData
    },
  })
}
