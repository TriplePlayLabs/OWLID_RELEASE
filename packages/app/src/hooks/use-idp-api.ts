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
  prewarmCredentialAttestations,
  storage,
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
import { currentPasskeyId, wrapWalletHolderKey } from '~/lib/passkeys'
import { beginVerificationSession, refreshWalletSession } from '~/lib/wallet-session'
import {
  backupIssuedCredential,
  restoreCredentialsFromVerifiedSession,
} from '~/lib/credential-recovery'

function bearerHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

function authedSessionsApi(token: string) {
  return getSessionsApi({ headers: bearerHeaders(token) })
}

function authedCredentialsApi(token: string) {
  return getCredentialsApi({ headers: bearerHeaders(token) })
}

async function tryRestoreVerifiedSession(
  sessionId: string,
  sessionToken: string,
): Promise<WalletCredential[]> {
  try {
    return await restoreCredentialsFromVerifiedSession({
      api: authedCredentialsApi(sessionToken),
      sessionId,
    })
  } catch (error) {
    console.warn('Encrypted credential restore failed', error)
    return []
  }
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
  /** Provider display name (e.g. "Google", "Didit") for user-facing copy. */
  providerName: string
}

/**
 * Status line shown while the holder is away in the provider window.
 * Names the actual provider (was hardcoded to "Didit") and only mentions
 * the document-upload mobile handoff for `webhook_async` flows — OIDC
 * redirects (e.g. Google) are a plain popup sign-in.
 */
export function redirectStatusMessage(active: ActiveRedirectSession | null): string | undefined {
  if (!active) return undefined
  const name = active.providerName.trim() || 'the provider'
  if (active.session.flowType === 'webhook_async') {
    return `Complete verification in ${name}. You can use ${name}'s mobile handoff; keep this tab open.`
  }
  return `Complete sign-in with ${name} in the popup window. Keep this tab open.`
}

async function issueAndStoreCredential(
  sessionId: string,
  sessionToken: string,
  providerId: string,
  claims: VerifiedIdentityClaims,
): Promise<WalletCredential> {
  if (!(await currentPasskeyId())) {
    throw new Error('No WebAuthn credential found. Please register first.')
  }

  // Wallet-held Ed25519 `cnf` key — its public key is bound into the
  // SD-JWT VC; its private seed signs the KB-JWT at presentation. The
  // passkey (existingWebAuthn) stays only as the unlock / UV gate.
  const holderKey = KeyPair.generate()
  const holderPublicKeyHex = holderKey.publicKeyHex()

  // Wrap the holder seed BEFORE asking the issuer to mint. The wrap
  // requires a passkey PRF assertion (UV prompt); if the user cancels
  // or PRF is unavailable, we must NOT burn the one-shot issuance slot
  // — `try_claim_issuance` flips `credential_issued` true→false only
  // once per session. Doing the wrap first means a UV failure leaves
  // the session reusable.
  const wrapped = await wrapWalletHolderKey(holderKey.toHex())

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

  // Holder seed was wrapped above before the /issue call. Plaintext
  // never touches storage; later use is gated by the passkey.
  await storage.addCredential(credential, wrapped)
  try {
    await backupIssuedCredential({
      api: authedCredentialsApi(sessionToken),
      sessionId,
      credential,
      holderSeedHex: holderKey.toHex(),
    })
  } catch (error) {
    console.warn('Encrypted credential backup failed', error)
  }
  // Pre-warm keyless attestations (email_verified, age@18) off the hot path,
  // fire-and-forget, so the first presentation hits `already-attested` instead
  // of waiting on a chain write. Never blocks issuance.
  void prewarmCredentialAttestations({ credential }).catch((error) =>
    console.warn('Attestation pre-warm failed (non-blocking)', error),
  )
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

  // A redirect verification hands focus to a provider window, backgrounding
  // this tab. Suspend auto-lock for its lifetime so the wallet does not lock
  // behind the user mid-verification; the completion poll below keeps the
  // unlock session warm so it does not lapse on the TTL either.
  useEffect(() => {
    if (!activeRedirect) return
    return beginVerificationSession()
  }, [activeRedirect])

  const startVerification = useMutation<
    WalletCredential | undefined,
    Error,
    { providerId: string; providerName: string; username: string; popup?: Window | null }
  >({
    mutationFn: async ({ providerId, providerName, popup }) => {
      // Step 1: Get existing WebAuthn credential (created during registration)
      if (!(await currentPasskeyId())) {
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
          providerName,
        })
        return undefined
      }

      if (flowType !== 'form_based') {
        popup?.close()
        throw new Error(`Provider flow ${flowType} is not supported by this holder flow yet.`)
      }
      popup?.close()

      const claims = await authedSessionsApi(session.sessionToken).autoVerify({
        id: session.sessionId,
      })
      // Restoring re-stores every backed-up card for this identity; return the
      // first so the mutation resolves, the rest surface via the cache invalidate.
      const restored = await tryRestoreVerifiedSession(session.sessionId, session.sessionToken)
      if (restored.length > 0) return restored[0]
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
      // Keep the unlock session warm while the user is away in the provider
      // window so it does not expire before they return.
      refreshWalletSession()
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
    mutationFn: async ({ session, claims }) => {
      const restored = await tryRestoreVerifiedSession(
        session.session.sessionId,
        session.sessionToken,
      )
      if (restored.length > 0) return restored[0]
      return issueAndStoreCredential(
        session.session.sessionId,
        session.sessionToken,
        session.session.providerId,
        claims,
      )
    },
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

  const terminalStatus = completion.data?.status
  const terminalError =
    terminalStatus === 'failed' || terminalStatus === 'expired'
      ? new Error(completion.data?.message || `Verification ${terminalStatus}`)
      : null

  // Verification completed at the provider but we have NOT yet asked the
  // issuer to mint. Mobile browsers refuse `navigator.credentials.get`
  // outside a user activation ("The document is not focused") so we
  // surface this as an awaiting-confirmation state and require the user
  // to tap a button — the click handler is the user gesture that lets
  // WebAuthn's PRF assertion run reliably on iOS / Android.
  const awaitingConfirmation =
    !!activeRedirect &&
    completion.data?.status === 'verified' &&
    !!completion.data.claims &&
    !issueVerifiedSession.isPending &&
    !issueVerifiedSession.isSuccess

  const confirmAndIssue = () => {
    if (!activeRedirect) return
    const data = completion.data
    if (!data || data.status !== 'verified' || !data.claims) return
    if (issueVerifiedSession.isPending || issueVerifiedSession.isSuccess) return
    issueVerifiedSessionMutate({
      session: activeRedirect,
      claims: data.claims as VerifiedIdentityClaims,
    })
  }

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
      (!!activeRedirect && !terminalError && !awaitingConfirmation),
    // Only the final issuance counts as success. startVerification merely
    // opened the redirect session — treating it as success here would render
    // "Card added" even when the provider later declines.
    isSuccess: issueVerifiedSession.isSuccess,
    isRedirecting: !!activeRedirect && !issueVerifiedSession.data,
    /** True once the provider says verified and we are waiting for the
     * user to tap "Save credential". The UI MUST gate the issue call on
     * a real click handler so WebAuthn's user-activation requirement is
     * satisfied on mobile browsers. */
    awaitingConfirmation,
    /** Click handler that fires the actual `/issue` call. Safe to bind
     * to a button — internally a no-op when not awaiting confirmation. */
    confirmAndIssue,
    statusMessage: redirectStatusMessage(activeRedirect),
  }
}
