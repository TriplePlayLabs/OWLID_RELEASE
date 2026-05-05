/**
 * Presentation Flow Hook
 *
 * State machine for the holder-side presentation protocol (ISO 18013-5 style).
 * 1. Holder creates session, shows QR
 * 2. Verifier scans QR, connects via WebSocket, sends request
 * 3. Holder reviews consent, approves with biometric
 * 4. ZK proof generated and sent over back-channel
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  Credential,
  PreparedToken,
  Token as NativeToken,
  encodeSessionEngagement,
  storage,
  type SessionEngagement,
  type PresentationRequest,
  type PresentationResponse,
  type WsMessage,
  type ProofRequest,
  type WebAuthnSignatureData,
} from '@owlid/sdk'
import { useWebAuthn } from '~/hooks/use-webauthn'
import { getProofPredicates } from '~/utils/proof-utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PresentationState =
  | 'idle'
  | 'creating'
  | 'showing_qr'
  | 'waiting'
  | 'consent'
  | 'generating'
  | 'sending'
  | 'complete'
  | 'error'

export interface PresentationResult {
  state: PresentationState
  sessionQr: string | null
  request: PresentationRequest | null
  error: string | null
  startPresentation: () => Promise<void>
  approve: () => Promise<void>
  deny: () => void
  cancel: () => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERIFICATION_URL = import.meta.env.VITE_VERIFICATION_URL || 'http://localhost:8000'
const MAX_RECONNECT_ATTEMPTS = 3
const RECONNECT_DELAY_MS = 1500

// ---------------------------------------------------------------------------
// Helpers (same pattern as use-proofs.ts)
// ---------------------------------------------------------------------------

function prepareTokenForWebAuthn(
  credentialJson: string,
  predicates: ProofRequest['predicates'],
  disclose: string[],
  challenge: string,
  ttlSeconds: number = 3600,
) {
  const proofDoc = Credential.fromJson(credentialJson)

  const proofRequest: ProofRequest = {
    disclose,
    predicates,
    trustedIssuers: [],
    challenge,
  }

  const preparedToken = proofDoc.prepare(proofRequest, ttlSeconds)

  return {
    preparedToken,
    webauthnChallenge: preparedToken.challenge(),
  }
}

function finalizeTokenWithWebAuthn(
  preparedTokenJson: string,
  webauthnSig: WebAuthnSignatureData,
  credentialPublicKey: string,
) {
  const preparedToken = PreparedToken.fromJson(preparedTokenJson)
  const token = NativeToken.finalizeWebauthn(preparedToken, webauthnSig, credentialPublicKey)

  return {
    token,
    tokenJson: token.toJson(),
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePresentation(): PresentationResult {
  const [state, setState] = useState<PresentationState>('idle')
  const [sessionQr, setSessionQr] = useState<string | null>(null)
  const [request, setRequest] = useState<PresentationRequest | null>(null)
  const [error, setError] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { signForToken } = useWebAuthn()

  // Clean up WebSocket and timers
  const cleanup = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (wsRef.current) {
      wsRef.current.onopen = null
      wsRef.current.onmessage = null
      wsRef.current.onerror = null
      wsRef.current.onclose = null
      if (
        wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING
      ) {
        wsRef.current.close()
      }
      wsRef.current = null
    }
  }, [])

  // Clean up on unmount
  useEffect(() => cleanup, [cleanup])

  // Convert http(s) URL to ws(s) URL
  const toWsUrl = useCallback((httpUrl: string): string => {
    return httpUrl.replace(/^http/, 'ws')
  }, [])

  // Connect WebSocket to session
  const connectWebSocket = useCallback(
    (sessionId: string) => {
      const wsBase = toWsUrl(VERIFICATION_URL)
      const wsUrl = `${wsBase}/ws/presentation/${sessionId}?role=holder`

      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        console.log('[Presentation] WebSocket connected')
        reconnectAttemptRef.current = 0
        setState('showing_qr')
      }

      ws.onmessage = (event) => {
        try {
          const msg: WsMessage = JSON.parse(event.data)

          switch (msg.type) {
            case 'session_ready':
              setState('waiting')
              break

            case 'request':
              setRequest(msg.payload as PresentationRequest)
              setState('consent')
              break

            case 'error': {
              const wsErr = msg.payload as { code: string; message: string }
              console.error('[Presentation] Server error:', wsErr)
              setError(wsErr.message || 'Server error')
              setState('error')
              break
            }

            default:
              console.warn('[Presentation] Unknown message type:', msg.type)
          }
        } catch (e) {
          console.error('[Presentation] Failed to parse WS message:', e)
        }
      }

      ws.onerror = (event) => {
        console.error('[Presentation] WebSocket error:', event)
      }

      ws.onclose = (event) => {
        console.log('[Presentation] WebSocket closed:', event.code, event.reason)

        // Only reconnect if we were in an active session (not intentionally closed)
        if (
          state !== 'idle' &&
          state !== 'complete' &&
          state !== 'error' &&
          reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS
        ) {
          reconnectAttemptRef.current += 1
          console.log(
            `[Presentation] Reconnecting (${reconnectAttemptRef.current}/${MAX_RECONNECT_ATTEMPTS})...`,
          )
          reconnectTimerRef.current = setTimeout(() => {
            connectWebSocket(sessionId)
          }, RECONNECT_DELAY_MS)
        } else if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
          setError('Connection lost. Please try again.')
          setState('error')
        }
      }
    },
    [toWsUrl, state],
  )

  // Start a new presentation session
  const startPresentation = useCallback(async () => {
    cleanup()
    setError(null)
    setRequest(null)
    setSessionQr(null)
    setState('creating')

    try {
      const res = await fetch(`${VERIFICATION_URL}/presentation/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })

      if (!res.ok) {
        throw new Error(`Failed to create session: ${res.status} ${res.statusText}`)
      }

      const data = await res.json()
      const { sessionId, nonce } = data

      sessionIdRef.current = sessionId

      // Build SessionEngagement QR data
      const engagement: SessionEngagement = {
        version: 1,
        ws: {
          url: `${toWsUrl(VERIFICATION_URL)}/ws/presentation/${sessionId}`,
          sessionId,
        },
        holderEphemeralKey: nonce,
        nonce,
      }

      const qrData = encodeSessionEngagement(engagement)
      setSessionQr(qrData)

      // Connect WebSocket
      connectWebSocket(sessionId)
    } catch (e) {
      console.error('[Presentation] Failed to start:', e)
      setError(e instanceof Error ? e.message : 'Failed to start presentation')
      setState('error')
    }
  }, [cleanup, toWsUrl, connectWebSocket])

  // Approve: generate ZK proof and send it
  const approve = useCallback(async () => {
    if (!request || !wsRef.current) {
      setError('No active request')
      setState('error')
      return
    }

    setState('generating')

    try {
      // Load credential and WebAuthn data
      const credentialData = await storage.loadCredentialData()
      const webauthnCred = await storage.loadWebAuthnCredential()

      if (!credentialData) {
        throw new Error('No credential data found. Complete identity verification first.')
      }
      if (!webauthnCred) {
        throw new Error('No WebAuthn credential found. Re-register with biometric authentication.')
      }

      const credentialJson = JSON.stringify(credentialData.credential)

      // Collect all predicates from the request
      const allPredicates = request.requestedPredicates.flatMap((p) => getProofPredicates(p.id))

      // Phase 1: Prepare token with ZK predicates, using session nonce as challenge
      const prepared = prepareTokenForWebAuthn(
        credentialJson,
        allPredicates,
        request.requestedDisclosures,
        request.nonce,
        3600,
      )

      // Phase 2: Sign with WebAuthn (triggers biometric prompt)
      const webauthnSig = await signForToken(webauthnCred.credentialId, prepared.webauthnChallenge)

      // Phase 3: Finalize token with WebAuthn signature
      const result = finalizeTokenWithWebAuthn(
        prepared.preparedToken.toJson(),
        {
          authenticatorData: webauthnSig.authenticatorData,
          clientDataJson: webauthnSig.clientDataJSON,
          signature: webauthnSig.signature,
        },
        webauthnCred.publicKey,
      )

      // Get compact token for transport
      const compactToken = result.token.toCompact()

      // Send response over WebSocket
      setState('sending')

      const response: PresentationResponse = {
        sessionId: request.sessionId,
        compactToken,
      }

      const wsMessage: WsMessage = {
        type: 'response',
        payload: response,
      }

      wsRef.current.send(JSON.stringify(wsMessage))
      setState('complete')

      // Auto-cleanup after a delay
      setTimeout(() => {
        cleanup()
      }, 5000)
    } catch (e) {
      console.error('[Presentation] Proof generation failed:', e)
      setError(e instanceof Error ? e.message : 'Proof generation failed')
      setState('error')
    }
  }, [request, signForToken, cleanup])

  // Deny: send consent_denied message
  const deny = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const msg: WsMessage = {
        type: 'consent_denied',
        payload: null,
      }
      wsRef.current.send(JSON.stringify(msg))
    }

    cleanup()
    setState('idle')
    setRequest(null)
    setSessionQr(null)
    setError(null)
  }, [cleanup])

  // Cancel: close WS and reset
  const cancel = useCallback(() => {
    cleanup()
    setState('idle')
    setRequest(null)
    setSessionQr(null)
    setError(null)
  }, [cleanup])

  return {
    state,
    sessionQr,
    request,
    error,
    startPresentation,
    approve,
    deny,
    cancel,
  }
}
