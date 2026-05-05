/**
 * Universal IDP Verification Hook
 *
 * Handles all identity provider verification flows:
 * - Form-based (mock providers)
 * - SAML redirect (DigiD, eIDAS)
 * - QR code polling (BankID)
 * - Webhook async (Onfido, Jumio, Didit)
 *
 * Uses generated OpenAPI clients from @owlid/sdk — no manual fetch.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { sessionsApi, internalApi, credentialsApi } from '~/lib/api'
import type {
  CreateSessionResponse,
  SessionResponse,
  ProviderFlowType,
  IdentitySubmissionForm,
  FormConfig,
  VerifiedIdentityClaims,
  CompleteVerificationResponse,
  PollResponse,
  SessionStatus,
} from '@owlid/sdk'

export interface IdpVerificationState {
  status: 'idle' | 'starting' | 'pending' | 'verifying' | 'verified' | 'failed' | 'expired'
  session: CreateSessionResponse | null
  sessionDetails: SessionResponse | null
  claims: VerifiedIdentityClaims | null
  error: string | null
  flowType: ProviderFlowType | null
  formConfig: FormConfig | null
  qrData: string | null
  redirectUrl: string | null
  pollMessage: string | null
  pollHint: string | null
  isPolling: boolean
  providerStatus: string | null
  warnings: string[]
}

export interface IdpVerificationActions {
  startVerification: (providerId: string) => Promise<CreateSessionResponse | null>
  submitForm: (form: IdentitySubmissionForm) => Promise<VerifiedIdentityClaims | null>
  checkStatus: () => Promise<SessionResponse | null>
  startPolling: () => void
  stopPolling: () => void
  resumeSession: (sessionId: string) => Promise<SessionResponse | null>
  issueCredential: (ownerPublicKey: string) => Promise<unknown>
  reset: () => void
}

const POLL_INTERVAL = 2000

const initialState: IdpVerificationState = {
  status: 'idle',
  session: null,
  sessionDetails: null,
  claims: null,
  error: null,
  flowType: null,
  formConfig: null,
  qrData: null,
  redirectUrl: null,
  pollMessage: null,
  pollHint: null,
  isPolling: false,
  providerStatus: null,
  warnings: [],
}

export function useIdpVerification(): IdpVerificationState & IdpVerificationActions {
  const [state, setState] = useState<IdpVerificationState>(initialState)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const pollFailureCountRef = useRef(0)

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
    }
  }, [])

  const startVerification = useCallback(async (providerId: string) => {
    setState((prev) => ({ ...prev, status: 'starting', error: null }))

    try {
      const response = await sessionsApi.createSession({ createSessionRequest: { providerId } })

      const flowType = response.flowType
      let formConfig: FormConfig | null = null
      let qrData: string | null = null
      let redirectUrl: string | null = null

      // The response has flattened VerificationStart fields
      // response.type tells us which variant
      const startType = (response as any).type as string | undefined
      if (startType === 'Form' || startType === 'form') {
        formConfig = (response as any).config ?? null
      } else if (startType === 'QrCode') {
        qrData = (response as any).qrData ?? null
      } else if (startType === 'Redirect' || startType === 'HostedUi') {
        redirectUrl = (response as any).url ?? null
      }

      setState((prev) => ({
        ...prev,
        status: 'pending',
        session: response,
        flowType,
        formConfig,
        qrData,
        redirectUrl,
        error: null,
      }))

      if (redirectUrl && (flowType === 'saml_redirect' || flowType === 'webhook_async')) {
        sessionStorage.setItem('owl_pending_session', response.sessionId)
        window.location.href = redirectUrl
      }

      return response
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start verification'
      setState((prev) => ({ ...prev, status: 'failed', error: message }))
      return null
    }
  }, [])

  const submitForm = useCallback(
    async (form: IdentitySubmissionForm) => {
      if (!state.session) {
        setState((prev) => ({ ...prev, error: 'No active session' }))
        return null
      }

      setState((prev) => ({ ...prev, status: 'verifying', error: null }))

      try {
        const claims = (await sessionsApi.submitIdentity({
          id: state.session.sessionId,
          body: form,
        })) as VerifiedIdentityClaims

        setState((prev) => ({ ...prev, status: 'verified', claims, error: null }))
        return claims
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Form submission failed'
        setState((prev) => ({ ...prev, status: 'failed', error: message }))
        return null
      }
    },
    [state.session],
  )

  const checkStatus = useCallback(async () => {
    if (!state.session) return null

    try {
      if (state.flowType === 'webhook_async') {
        const result = (await sessionsApi.completeVerification({
          id: state.session.sessionId,
        })) as CompleteVerificationResponse

        if (result.status === 'verified' && result.claims) {
          setState((prev) => ({
            ...prev,
            status: 'verified',
            claims: result.claims!,
            error: null,
            providerStatus: null,
            warnings: [],
          }))
          return { status: 'verified' as SessionStatus } as SessionResponse
        } else {
          setState((prev) => ({
            ...prev,
            pollMessage: result.message || 'Verification in progress...',
            providerStatus: result.providerStatus || null,
            warnings: [],
          }))
          return { status: 'pending' as SessionStatus } as SessionResponse
        }
      }

      const details = (await sessionsApi.getSession({
        id: state.session.sessionId,
      })) as SessionResponse

      if (details.status === 'verified') {
        const claims = (await sessionsApi.getClaims({
          id: state.session.sessionId,
        })) as VerifiedIdentityClaims
        setState((prev) => ({
          ...prev,
          status: 'verified',
          sessionDetails: details,
          claims,
          error: null,
        }))
      } else if (details.status === 'failed') {
        setState((prev) => ({
          ...prev,
          status: 'failed',
          sessionDetails: details,
          error: 'Verification failed',
        }))
      } else if (details.status === 'expired' || details.isExpired) {
        setState((prev) => ({
          ...prev,
          status: 'expired',
          sessionDetails: details,
          error: 'Session expired',
        }))
      } else {
        setState((prev) => ({ ...prev, sessionDetails: details }))
      }

      return details
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to check status'
      setState((prev) => ({ ...prev, error: message }))
      return null
    }
  }, [state.session, state.status, state.flowType])

  const doPoll = useCallback(async () => {
    if (!state.session) return

    try {
      const result = (await internalApi.pollSession({
        sessionId: state.session.sessionId,
      })) as PollResponse

      pollFailureCountRef.current = 0

      setState((prev) => ({
        ...prev,
        pollMessage: result.message,
        pollHint: result.hint || null,
      }))

      const stopPolling = () => {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current)
          pollIntervalRef.current = null
        }
      }

      if (result.status === 'verified') {
        stopPolling()
        const claims = (await sessionsApi.getClaims({
          id: state.session.sessionId,
        })) as VerifiedIdentityClaims
        setState((prev) => ({
          ...prev,
          status: 'verified',
          claims,
          isPolling: false,
          error: null,
        }))
      } else if (result.status === 'failed') {
        stopPolling()
        setState((prev) => ({
          ...prev,
          status: 'failed',
          isPolling: false,
          error: result.message,
        }))
      } else if (result.status === 'expired') {
        stopPolling()
        setState((prev) => ({
          ...prev,
          status: 'expired',
          isPolling: false,
          error: 'Session expired',
        }))
      } else if (result.status === 'verifying') {
        setState((prev) => ({ ...prev, status: 'verifying' }))
      }
    } catch {
      pollFailureCountRef.current++
      if (pollFailureCountRef.current > 3) {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current)
          pollIntervalRef.current = null
        }
        setState((prev) => ({
          ...prev,
          status: 'failed',
          isPolling: false,
          error: 'Polling failed after multiple attempts',
        }))
      }
    }
  }, [state.session])

  const startPolling = useCallback(() => {
    if (pollIntervalRef.current) return
    pollFailureCountRef.current = 0
    setState((prev) => ({ ...prev, isPolling: true }))
    doPoll()
    pollIntervalRef.current = setInterval(doPoll, POLL_INTERVAL)
  }, [doPoll])

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
    setState((prev) => ({ ...prev, isPolling: false }))
  }, [])

  const resumeSession = useCallback(async (sessionId: string) => {
    setState((prev) => ({ ...prev, status: 'verifying', error: null }))

    try {
      const details = (await sessionsApi.getSession({ id: sessionId })) as SessionResponse

      const session: CreateSessionResponse = {
        sessionId: details.id,
        providerId: details.providerId,
        flowType: details.flowType,
        status: details.status,
        expiresAt: details.expiresAt,
      } as CreateSessionResponse

      if (details.status === 'verified') {
        const claims = (await sessionsApi.getClaims({ id: sessionId })) as VerifiedIdentityClaims
        setState((prev) => ({
          ...prev,
          status: 'verified',
          session,
          sessionDetails: details,
          claims,
          flowType: details.flowType,
          error: null,
        }))
      } else if (details.status === 'failed') {
        setState((prev) => ({
          ...prev,
          status: 'failed',
          session,
          sessionDetails: details,
          flowType: details.flowType,
          error: 'Verification failed',
        }))
      } else {
        setState((prev) => ({
          ...prev,
          status: 'pending',
          session,
          sessionDetails: details,
          flowType: details.flowType,
        }))
      }

      return details
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to resume session'
      setState((prev) => ({ ...prev, status: 'failed', error: message }))
      return null
    }
  }, [])

  const issueCredential = useCallback(
    async (ownerPublicKey: string, keyAlgorithm: 'p256' | 'ed25519' = 'p256') => {
      if (!state.session || state.status !== 'verified') {
        throw new Error('No verified session')
      }

      const response = await credentialsApi.issueCredential({
        id: state.session.sessionId,
        issueCredentialRequest: { ownerPublicKey, keyAlgorithm },
      })
      return response.credential
    },
    [state.session, state.status],
  )

  const reset = useCallback(() => {
    stopPolling()
    sessionStorage.removeItem('owl_pending_session')
    setState(initialState)
  }, [stopPolling])

  useEffect(() => {
    const pendingSessionId = sessionStorage.getItem('owl_pending_session')
    if (pendingSessionId) {
      sessionStorage.removeItem('owl_pending_session')
      resumeSession(pendingSessionId)
    }
  }, [resumeSession])

  return {
    ...state,
    startVerification,
    submitForm,
    checkStatus,
    startPolling,
    stopPolling,
    resumeSession,
    issueCredential,
    reset,
  }
}
