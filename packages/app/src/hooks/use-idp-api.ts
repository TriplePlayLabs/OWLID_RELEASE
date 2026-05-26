/**
 * TanStack Query hooks for Issuer API calls
 *
 * Clean separation of API state management using React Query.
 * Uses WebAuthn for hardware-backed security - no private keys stored.
 */

import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  KeyPair,
  SdJwtVc,
  buildCardShape,
  storage,
  wrapHolderKey,
  type VerifiedClaims,
  type WalletCredential,
} from '@owlid/sdk'
import type {
  CompleteVerificationResponse,
  CreateSessionResponse,
  ProviderInfo,
  VerifiedIdentityClaims,
} from '@owlid/issuer-client'
import { getCredentialsApi, getSessionsApi } from '@owlid/sdk/issuer'

import { providersApi, sessionsApi, infoApi } from '~/lib/api'

function bearerHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

function authedSessionsApi(token: string) {
  return getSessionsApi({ headers: bearerHeaders(token) })
}

function authedCredentialsApi(token: string) {
  return getCredentialsApi({ headers: bearerHeaders(token) })
}

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString().substring(0, 10) : value
}

function isoDateTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function optionalIsoDate(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined
  return isoDate(value)
}

function optionalString(value: string | null | undefined): string | undefined {
  return value ?? undefined
}

function toStoredClaims(claims: VerifiedIdentityClaims): VerifiedClaims {
  return {
    firstName: claims.firstName,
    lastName: claims.lastName,
    dateOfBirth: isoDate(claims.dateOfBirth),
    placeOfBirth: claims.placeOfBirth,
    nationality: claims.nationality,
    gender: optionalString(claims.gender),
    nationalId: claims.nationalId,
    passportNumber: optionalString(claims.passportNumber),
    driversLicense: optionalString(claims.driversLicense),
    taxId: optionalString(claims.taxId),
    documentType: optionalString(claims.documentType),
    documentNumber: optionalString(claims.documentNumber),
    issuingCountry: optionalString(claims.issuingCountry),
    documentExpiry: optionalIsoDate(claims.documentExpiry),
    documentIssueDate: optionalIsoDate(claims.documentIssueDate),
    portraitImage: optionalString(claims.portraitImage),
    streetAddress: claims.streetAddress,
    city: claims.city,
    postalCode: claims.postalCode,
    country: claims.country,
    isOver18: claims.isOver18,
    isOver21: claims.isOver21,
    isOver65: claims.isOver65,
    isEuCitizen: claims.isEuCitizen,
    isResident: claims.isResident,
    verificationLevel: claims.verificationLevel,
    verifiedAt: isoDateTime(claims.verifiedAt),
    verifiedBy: claims.providerId,
    verificationMethod: claims.verificationMethod,
    email: optionalString(claims.email),
    emailVerified: claims.emailVerified ?? undefined,
    name: optionalString(claims.name),
    pictureUrl: optionalString(claims.picture),
    locale: optionalString(claims.locale),
    hostedDomain: optionalString(claims.hostedDomain),
  }
}

// Query keys
export const issuerQueryKeys = {
  all: ['issuer'] as const,
  providers: () => [...issuerQueryKeys.all, 'providers'] as const,
  session: (sessionId: string) => [...issuerQueryKeys.all, 'session', sessionId] as const,
  completion: (sessionId: string) => [...issuerQueryKeys.session(sessionId), 'completion'] as const,
  claims: (sessionId: string) => [...issuerQueryKeys.all, 'claims', sessionId] as const,
  health: () => [...issuerQueryKeys.all, 'health'] as const,
}

interface ActiveRedirectSession {
  session: CreateSessionResponse
  sessionToken: string
  popup: Window | null
}

async function issueAndStoreCredential(
  sessionId: string,
  sessionToken: string,
  providerId: string,
  claims: VerifiedIdentityClaims,
): Promise<WalletCredential> {
  const existingWebAuthn = await storage.loadWebAuthnCredential()
  if (!existingWebAuthn) {
    throw new Error('No WebAuthn credential found. Please register first.')
  }

  // Wallet-held Ed25519 `cnf` key — its public key is bound into the
  // SD-JWT VC; its private seed signs the KB-JWT at presentation. The
  // passkey (existingWebAuthn) stays only as the unlock / UV gate.
  const holderKey = KeyPair.generate()
  const holderPublicKeyHex = holderKey.publicKeyHex()

  const issueResponse = await authedCredentialsApi(sessionToken).issueCredential({
    id: sessionId,
    issueCredentialRequest: { ownerPublicKey: holderPublicKeyHex, keyAlgorithm: 'ed25519' },
  })

  if (!issueResponse.success) {
    throw new Error(issueResponse.error || 'Failed to issue credential')
  }

  const sdJwtVc = issueResponse.credential
  const parsed = SdJwtVc.parse(sdJwtVc)
  const verifiedClaims = toStoredClaims(claims)
  // Holder-only unique-personhood witness — stored locally with the
  // credential so the witness-on-device orchestrator can prove
  // `attestUniquePersonhood`. Present only for document-verified /
  // government-eID identities; never disclosed to a verifier.
  if (issueResponse.personhoodSecretHex) {
    verifiedClaims.personhoodSecret = issueResponse.personhoodSecretHex
  }
  const credential: WalletCredential = {
    credentialId: parsed.credentialId(),
    sdJwtVc,
    issuer: parsed.peekIssuer(),
    providerId,
    issuedAt: new Date().toISOString(),
    cardShape: buildCardShape(providerId, verifiedClaims),
    verifiedClaims,
    holderPublicKeyHex,
  }

  // Encrypt the Ed25519 holder seed with the passkey PRF before persisting —
  // plaintext never touches storage; later use is gated by the passkey.
  const wrapped = await wrapHolderKey(existingWebAuthn.credentialId, holderKey.toHex())
  await storage.addCredential(credential, wrapped)
  return credential
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
 * - webhook_async (Didit): open hosted flow and poll the server session
 *
 * Didit may hand off KYC to mobile from inside its hosted page. OwlID still
 * keeps the bearer session token only in the original desktop tab; that tab
 * polls the server session and performs credential issuance after verification.
 */
export function useVerifyAndIssueWithWebAuthn() {
  const [activeRedirect, setActiveRedirect] = useState<ActiveRedirectSession | null>(null)
  const queryClient = useQueryClient()

  const startVerification = useMutation<
    WalletCredential | undefined,
    Error,
    { providerId: string; username: string; popup?: Window | null }
  >({
    mutationFn: async ({ providerId, popup }) => {
      // Step 1: Get existing WebAuthn credential (created during registration)
      const existingWebAuthn = await storage.loadWebAuthnCredential()
      if (!existingWebAuthn) {
        popup?.close()
        throw new Error('No WebAuthn credential found. Please register first.')
      }

      // Step 2: Create session
      let session: CreateSessionResponse
      try {
        session = await sessionsApi.createSession({
          createSessionRequest: { providerId },
        })
      } catch (error) {
        popup?.close()
        throw error
      }

      // Step 3: Handle verification based on flow type
      let claims: VerifiedIdentityClaims
      const flowType = session.flowType

      // Both Didit (webhook_async) and OIDC providers (oidc_redirect)
      // hand off to an external URL and complete server-side; the holder
      // just needs to open the URL and poll /sessions/{id}/complete.
      if (flowType === 'webhook_async' || flowType === 'oidc_redirect') {
        const redirectUrl = session.url
        if (!redirectUrl) {
          popup?.close()
          throw new Error('No redirect URL provided by provider')
        }

        const provWindow = popup ?? window.open('', '_blank', 'popup,width=520,height=760')
        if (!provWindow || provWindow.closed) {
          throw new Error(
            'Could not open the verification window. Allow popups for this site and try again.',
          )
        }
        provWindow.location.href = redirectUrl

        setActiveRedirect({
          session,
          sessionToken: session.sessionToken,
          popup: provWindow,
        })
        return undefined
      }

      if (flowType !== 'form_based') {
        popup?.close()
        throw new Error(`Provider flow ${flowType} is not supported by this holder flow yet.`)
      }
      popup?.close()

      claims = await authedSessionsApi(session.sessionToken).autoVerify({ id: session.sessionId })
      return issueAndStoreCredential(
        session.sessionId,
        session.sessionToken,
        session.providerId,
        claims,
      )
    },
    onSuccess: (cred) => {
      // Newly stored credential — refresh the wallet list immediately so
      // the card appears without a manual page reload.
      if (cred) queryClient.invalidateQueries({ queryKey: ['wallet'] })
    },
  })

  const completion = useQuery<CompleteVerificationResponse, Error>({
    queryKey: issuerQueryKeys.completion(activeRedirect?.session.sessionId ?? ''),
    queryFn: () => {
      if (!activeRedirect) {
        throw new Error('No active verification session')
      }
      return authedSessionsApi(activeRedirect.sessionToken).completeVerification({
        id: activeRedirect.session.sessionId,
      })
    },
    enabled: !!activeRedirect,
    refetchInterval: (query) => {
      // A non-retryable HTTP error (e.g. 5xx from a broken provider) is
      // terminal too — without this the UI would spin forever after the
      // retry budget is exhausted.
      if (query.state.error) return false
      const data = query.state.data
      if (!data) return 2000
      if (data.status === 'verified' || data.status === 'failed' || data.status === 'expired') {
        return false
      }
      return Math.max((data.retryAfterSecs ?? 2) * 1000, 1000)
    },
    retry: 2,
  })

  const issueVerifiedSession = useMutation<
    WalletCredential,
    Error,
    { session: ActiveRedirectSession; claims: VerifiedIdentityClaims }
  >({
    mutationFn: ({ session, claims }) =>
      issueAndStoreCredential(
        session.session.sessionId,
        session.sessionToken,
        session.session.providerId,
        claims,
      ),
    onSuccess: (_, vars) => {
      vars.session.popup?.close()
      setActiveRedirect(null)
      // Didit / OIDC issuance completes on a polling tick while the
      // holder may already be looking at the wallet — invalidate so the
      // new card shows up without a manual refresh.
      queryClient.invalidateQueries({ queryKey: ['wallet'] })
    },
  })
  const issueVerifiedSessionMutate = issueVerifiedSession.mutate

  useEffect(() => {
    const data = completion.data
    if (
      !activeRedirect ||
      !data ||
      data.status !== 'verified' ||
      !data.claims ||
      issueVerifiedSession.isPending ||
      issueVerifiedSession.isSuccess
    ) {
      return
    }

    issueVerifiedSessionMutate({
      session: activeRedirect,
      claims: data.claims as VerifiedIdentityClaims,
    })
  }, [
    activeRedirect,
    completion.data,
    issueVerifiedSession.isPending,
    issueVerifiedSession.isSuccess,
    issueVerifiedSessionMutate,
  ])

  const terminalStatus = completion.data?.status
  const terminalError =
    terminalStatus === 'failed' || terminalStatus === 'expired'
      ? new Error(completion.data?.message || `Verification ${terminalStatus}`)
      : null

  return {
    mutateAsync: startVerification.mutateAsync,
    reset: () => {
      activeRedirect?.popup?.close()
      setActiveRedirect(null)
      startVerification.reset()
      issueVerifiedSession.reset()
    },
    data: issueVerifiedSession.data ?? startVerification.data,
    credentialData: issueVerifiedSession.data ?? startVerification.data,
    error:
      startVerification.error ?? completion.error ?? issueVerifiedSession.error ?? terminalError,
    isError:
      startVerification.isError ||
      completion.isError ||
      issueVerifiedSession.isError ||
      terminalError !== null,
    isPending:
      startVerification.isPending ||
      completion.isFetching ||
      issueVerifiedSession.isPending ||
      (!!activeRedirect && !terminalError),
    // Only the final issuance counts as success. startVerification merely
    // opened the redirect session — treating it as success here would render
    // "Card added" even when the provider later declines.
    isSuccess: issueVerifiedSession.isSuccess,
    isRedirecting: !!activeRedirect && !issueVerifiedSession.data,
    statusMessage: activeRedirect
      ? "Complete verification in Didit. You can use Didit's mobile handoff; keep this tab open."
      : undefined,
  }
}
