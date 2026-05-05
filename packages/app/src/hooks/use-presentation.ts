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
  circuitsForPredicates,
  Credential,
  ensureProvingKeysFor,
  PreparedToken,
  Token as NativeToken,
} from '@owlid/sdk/native'
import {
  encodeSessionEngagement,
  getVerificationUrl,
  getWsBaseUrl,
  parseProofError,
  storage,
  type SessionEngagement,
  type PresentationRequest,
  type PresentationResponse,
  type WsMessage,
  type ProofRequest,
  type WebAuthnSignatureData,
} from '@owlid/sdk'
import { useWebAuthn } from '~/hooks/use-webauthn'
import { usePredicates } from '~/hooks/use-predicates'
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
  /**
   * Holder evaluated the predicate locally and does not satisfy it. This is
   * a normal terminal state — distinct from `error` so the UI doesn't claim
   * something went wrong.
   */
  | 'not_satisfied'
  | 'error'

/**
 * Result of evaluating one requested predicate against the holder's local
 * credential, before any proof is generated. Drives the consent screen
 * badges. Pure-local — never crosses the wire.
 */
export interface PredicateCheck {
  id: string
  label: string
  satisfied: boolean
}

export interface PresentationResult {
  state: PresentationState
  sessionQr: string | null
  request: PresentationRequest | null
  /** Pre-flight pass/fail per requested predicate, or `null` while loading. */
  predicateChecks: PredicateCheck[] | null
  /** Generic, sanitized message for the `error` state. Never includes
   * credential-derived data — those flow into `not_satisfied` instead. */
  error: string | null
  /** Set in `not_satisfied`; the field name the failing predicate targeted. */
  unmetAttribute: string | null
  startPresentation: () => Promise<void>
  approve: () => Promise<void>
  deny: () => void
  cancel: () => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERIFICATION_URL = getVerificationUrl()
const MAX_RECONNECT_ATTEMPTS = 3
const RECONNECT_DELAY_MS = 1500

// ---------------------------------------------------------------------------
// Helpers (same pattern as use-proofs.ts)
// ---------------------------------------------------------------------------

async function prepareTokenForWebAuthn(
  credentialJson: string,
  predicates: ProofRequest['predicates'],
  disclose: string[],
  challenge: string,
  ttlSeconds: number = 3600,
) {
  // No-op on native, IDB-cached fetch on WASM. Only loads circuits the
  // request actually needs.
  await ensureProvingKeysFor(circuitsForPredicates(predicates))

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
  const [unmetAttribute, setUnmetAttribute] = useState<string | null>(null)
  const [predicateChecks, setPredicateChecks] = useState<PredicateCheck[] | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Mirror of `state` for use inside async ws callbacks (close/error/message)
  // where the captured closure would otherwise be stale.
  const stateRef = useRef<PresentationState>('idle')
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const { signForToken } = useWebAuthn()
  const { data: registry } = usePredicates()

  // Pre-flight: when the verifier sends a request, evaluate each predicate
  // against the local credential before the user even sees the consent
  // screen. This is pure-local — `evaluatePredicates` reads plaintext
  // attributes and returns booleans, no proof, no network. Drives the
  // consent UI's pass/fail badges.
  useEffect(() => {
    let cancelled = false
    if (!request) {
      setPredicateChecks(null)
      return () => {
        cancelled = true
      }
    }
    ;(async () => {
      try {
        const credentialData = await storage.loadCredentialData()
        if (!credentialData || cancelled) return
        const proofDoc = Credential.fromJson(JSON.stringify(credentialData.credential))
        const results: PredicateCheck[] = request.requestedPredicates.map((p) => {
          const proofPreds = getProofPredicates(p.id, registry)
          if (proofPreds.length === 0) {
            return { id: p.id, label: p.label, satisfied: false }
          }
          const evalRequest: ProofRequest = {
            disclose: [],
            predicates: proofPreds,
            trustedIssuers: [],
            challenge: '',
          }
          try {
            const json = proofDoc.evaluatePredicates(evalRequest)
            const arr = JSON.parse(json) as Array<{ satisfied: boolean }>
            const satisfied = arr.length > 0 && arr.every((e) => e.satisfied)
            return { id: p.id, label: p.label, satisfied }
          } catch {
            // Malformed input or missing attribute — treat as unsatisfied.
            return { id: p.id, label: p.label, satisfied: false }
          }
        })
        if (!cancelled) setPredicateChecks(results)
      } catch {
        if (!cancelled) setPredicateChecks(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [request, registry])

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

  // Connect WebSocket to session
  const connectWebSocket = useCallback(
    (sessionId: string) => {
      const wsUrl = `${getWsBaseUrl()}/ws/presentation/${sessionId}?role=holder`

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
              // The verifier intentionally closes its socket once it has
              // received our response and finished verifying — backend
              // relays that as a 'Peer disconnected' transport_error to
              // us. From the holder's view that is a happy path, not a
              // failure: don't override `complete` or replay an error
              // message after we already finished.
              if (
                stateRef.current === 'complete' ||
                stateRef.current === 'not_satisfied' ||
                stateRef.current === 'error' ||
                stateRef.current === 'idle'
              ) {
                break
              }
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

        // Use stateRef (not the captured `state` closure value) so we read
        // the latest transition. Skip reconnect / error if we're already
        // done — sending the response cleanly is the happy path.
        const cur = stateRef.current
        if (cur === 'idle' || cur === 'complete' || cur === 'not_satisfied' || cur === 'error')
          return

        if (reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttemptRef.current += 1
          console.log(
            `[Presentation] Reconnecting (${reconnectAttemptRef.current}/${MAX_RECONNECT_ATTEMPTS})...`,
          )
          reconnectTimerRef.current = setTimeout(() => {
            connectWebSocket(sessionId)
          }, RECONNECT_DELAY_MS)
        } else {
          setError('Connection lost. Please try again.')
          setState('error')
        }
      }
    },
    // No `state` dep — we read live state via stateRef inside the ws
    // callbacks. Re-running this on every state change would tear down
    // and re-open the socket mid-flow.
    [],
  )

  // Start a new presentation session
  const startPresentation = useCallback(async () => {
    cleanup()
    setError(null)
    setUnmetAttribute(null)
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

      // Build SessionEngagement QR data.
      // ws.url is a relative path; the verifier prepends its own base. This
      // lets the verifier reach the service via a different hostname/origin
      // than the one the holder uses (typical for split deployments).
      const engagement: SessionEngagement = {
        version: 1,
        ws: {
          url: `/ws/presentation/${sessionId}`,
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
  }, [cleanup, connectWebSocket])

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

      // Collect all predicates from the request, looking up wire shape via the registry.
      const allPredicates = request.requestedPredicates.flatMap((p) =>
        getProofPredicates(p.id, registry),
      )

      // Phase 1: Prepare token with ZK predicates, using session nonce as challenge
      const prepared = await prepareTokenForWebAuthn(
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
      // PRIVACY: never relay `e.message` — Rust-side errors used to embed
      // the witness ("Age 33 is less than threshold 65"). The native SDK now
      // emits typed errors through `parseProofError`; non-typed errors get
      // a fixed sanitized message so nothing credential-derived crosses.
      const proofErr = parseProofError(e)
      const sendOverWs = (msg: WsMessage) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          try {
            wsRef.current.send(JSON.stringify(msg))
          } catch {
            // best-effort; verifier falls back to its transport_error path
          }
        }
      }

      if (proofErr?.code === 'PREDICATE_NOT_SATISFIED') {
        // Normal terminal outcome — holder doesn't meet the requirement.
        // Tell the verifier with a typed message carrying only the
        // attribute name (which they already asked about), then move to a
        // dedicated UI state — NOT `error`.
        const attr = proofErr.attribute ?? ''
        sendOverWs({
          type: 'predicate_not_satisfied',
          payload: { attribute: attr, predicateId: proofErr.predicateId },
        })
        setUnmetAttribute(attr || null)
        setState('not_satisfied')
        return
      }

      // Map specific known proof errors to user-facing messages. Anything
      // unparsed becomes a generic "proof failed" — never surface raw
      // `e.message` because that may carry private witness data from older
      // SDK builds.
      const localMessage = (() => {
        switch (proofErr?.code) {
          case 'MISSING_ATTRIBUTE':
            return `Your credential is missing a required field${proofErr.attribute ? ` (${proofErr.attribute})` : ''}.`
          case 'TOKEN_EXPIRED':
            return 'Your credential has expired.'
          case 'TOKEN_NOT_ACTIVE':
            return 'Your credential is not yet active.'
          case 'CHALLENGE_MISMATCH':
            return 'Session challenge mismatch — please retry.'
          case 'CREDENTIAL_REVOKED':
            return 'Your credential has been revoked.'
          case 'UNTRUSTED_ISSUER':
            return "Your credential's issuer is not trusted by this verifier."
          case 'PROOF_FAILED':
            return 'Proof generation failed.'
          default:
            return 'Proof generation failed.'
        }
      })()

      console.error(
        '[Presentation] Proof generation failed (sanitized): %s',
        proofErr?.code ?? 'unknown',
      )
      sendOverWs({ type: 'proof_failed', payload: { code: 'proof_failed' } })
      setError(localMessage)
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
    setUnmetAttribute(null)
  }, [cleanup])

  // Cancel: close WS and reset
  const cancel = useCallback(() => {
    cleanup()
    setState('idle')
    setRequest(null)
    setSessionQr(null)
    setError(null)
    setUnmetAttribute(null)
  }, [cleanup])

  return {
    state,
    sessionQr,
    request,
    predicateChecks,
    error,
    unmetAttribute,
    startPresentation,
    approve,
    deny,
    cancel,
  }
}
