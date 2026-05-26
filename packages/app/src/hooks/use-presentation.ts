/**
 * Presentation flow hook.
 *
 * State machine for the holder-side presentation protocol (ISO 18013-5
 * style). The holder creates a session, shows a QR; the verifier scans,
 * sends a DCQL request over the back-channel; the wallet solves it
 * locally; the holder approves; the wallet builds one KB-JWT per chosen
 * credential and POSTs a vp_token map back over the WebSocket.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  encodeSessionEngagement,
  getWsBaseUrl,
  matchDcqlAgainst,
  OwlWallet,
  storage,
  unwrapHolderKey,
  type AttestProgress,
  type DcqlMatchSummary,
  type DcqlRequest,
  type PresentationRequest,
  type PresentationResponse,
  type SessionEngagement,
  type WsMessage,
} from '@owlid/sdk'
import { getPresentationApi } from '@owlid/verifier-client'

export type PresentationState =
  | 'idle'
  | 'creating'
  | 'showing_qr'
  | 'waiting'
  | 'consent'
  | 'generating'
  | 'sending'
  | 'complete'
  | 'denied'
  | 'error'

export interface PresentationResult {
  state: PresentationState
  sessionQr: string | null
  request: PresentationRequest | null
  /** Wallet's DCQL match summary for `request`. Drives the per-card
   *  breakdown in the consent UI. `null` while loading. */
  matchSummary: DcqlMatchSummary | null
  /** Holder-chosen credential per DCQL query id. Empty entries fall
   *  back to the wallet's default (newest matching credential). */
  overrides: Record<string, string>
  /** Swap the credential answering a DCQL query before approve. */
  setOverride: (dcqlId: string, credentialId: string) => void
  /** Latest predicate-attestation step the wallet is in while the
   *  state is `generating`. Cleared once the wallet moves on to
   *  `sending`. Drives the "Generating proof for X on device…" /
   *  "Submitting to Midnight…" copy in the consent modal. */
  attestProgress: AttestProgress | null
  error: string | null
  startPresentation: () => Promise<void>
  approve: () => Promise<void>
  deny: () => void
  cancel: () => void
}

// Quick retries cover a brief blip; the primary recovery path is the
// visibility/focus/online listeners, so a phone locked for minutes
// still resumes on unlock.
const QUICK_RECONNECT_ATTEMPTS = 2
const RECONNECT_DELAY_MS = 1500

/** States from which a transport drop is recoverable — the session is
 *  in flight but not yet resolved. `consent`/`generating` are included
 *  so a lock mid-consent still resumes. */
const NON_TERMINAL_STATES: ReadonlySet<PresentationState> = new Set([
  'creating',
  'showing_qr',
  'waiting',
  'consent',
  'generating',
  'sending',
])

const FRIENDLY_PREDICATE_NAME: Record<string, string> = {
  age: 'age',
  kyc: 'identity verification level',
  residency: 'resident status',
  email_verified: 'verified email',
  nationality: 'nationality',
  age_range: 'age range',
  unique_personhood: 'unique person',
}

function friendlyPredicate(p: string): string {
  return FRIENDLY_PREDICATE_NAME[p] ?? p
}

/** Map the last seen orchestrator phase to a human label so the
 *  consent modal can prefix the underlying error with the substep
 *  that was active (e.g. "Generating proof for age…"). */
function attestProgressStageLabel(p: AttestProgress | null): string | undefined {
  if (!p) return undefined
  switch (p.stage) {
    case 'check':
      return `Checking your ${friendlyPredicate(p.predicate)} proof`
    case 'snapshot':
      return `Reading verifier requirements for ${friendlyPredicate(p.predicate)}`
    case 'prove':
      return `Generating proof for ${friendlyPredicate(p.predicate)}`
    case 'relay':
      return `Submitting your ${friendlyPredicate(p.predicate)} proof`
    default:
      return undefined
  }
}

/** Translate the raw error message from the proving pipeline into
 *  language a regular user can act on. Falls back to the raw message
 *  when nothing maps. */
function humanizeError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('failed assert: kyc below threshold')) {
    return "Your ID's identity verification level is too low for this verifier."
  }
  if (m.includes('failed assert: age below')) {
    return "Your date of birth doesn't meet the age this verifier requires."
  }
  if (m.includes('failed assert: not a verified resident')) {
    return 'Your ID does not show you as a verified resident.'
  }
  if (m.includes('failed assert: email not verified')) {
    return 'Your ID does not include a provider-verified email.'
  }
  if (m.includes('failed assert: nationality not in approved set')) {
    return "Your nationality isn't in the verifier's accepted list."
  }
  if (m.includes('personhood replay')) {
    return 'You already verified that you are a unique person for this campaign. You can only claim it once.'
  }
  if (m.includes('network id has not been configured')) {
    return 'App startup error — please reload the page.'
  }
  if (m.includes('no passkey')) {
    return 'No passkey found on this device. Register again to continue.'
  }
  if (m.includes('signature error') || m.includes('invalid signature')) {
    return 'Your ID looks tampered or was issued by a server we no longer trust. Re-issue your ID and try again.'
  }
  if (m.includes('cors') || m.includes('failed to fetch')) {
    return "Couldn't reach the verifier service. Check your connection and retry."
  }
  return message
}

/** Build the DCQL request the wallet will solve. Verifiers running the
 *  current OwlID stack always send `dcql`; the wallet refuses requests
 *  without it. */
function buildDcql(req: PresentationRequest): DcqlRequest {
  if (!req.dcql) {
    throw new Error('Verifier sent no DCQL query — refusing presentation')
  }
  return req.dcql as DcqlRequest
}

export function usePresentation(): PresentationResult {
  const [state, setState] = useState<PresentationState>('idle')
  const [sessionQr, setSessionQr] = useState<string | null>(null)
  const [request, setRequest] = useState<PresentationRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [matchSummary, setMatchSummary] = useState<DcqlMatchSummary | null>(null)
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [attestProgress, setAttestProgress] = useState<AttestProgress | null>(null)
  // Track the latest progress event in a ref so the `approve` catch
  // block reads the substep that was active when the throw fired,
  // without recreating the callback on every progress tick.
  const attestProgressRef = useRef<AttestProgress | null>(null)

  const setOverride = useCallback((dcqlId: string, credentialId: string) => {
    setOverrides((prev) => ({ ...prev, [dcqlId]: credentialId }))
  }, [])

  const wsRef = useRef<WebSocket | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const reconnectAttemptRef = useRef(0)
  // Per-session abort: aborted by `cancel()` / `deny()` so an
  // in-flight `wallet.present()` tears down its SSE subscription and
  // returns immediately instead of running to completion in the
  // background after the modal closes.
  const abortRef = useRef<AbortController | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stateRef = useRef<PresentationState>('idle')
  // Tracks whether this hook instance is still mounted. Async work
  // (createSession, wallet.present, fetch) that resolves after unmount
  // must not touch state, wsRef, or open new sockets — otherwise the
  // post-unmount WS becomes an orphan no `cleanup()` can ever reach,
  // which is exactly what produced the ghost connections in devtools.
  const aliveRef = useRef(true)
  // Aborts any in-flight `getPresentationApi().createSession({...})`
  // POST started by `startPresentation`. Without this, a fast
  // open→close (or a `state==='error'` retry that races the previous
  // attempt) lets the previous POST settle after the unmount and
  // calls `connectWebSocket(...)` on a dead hook instance.
  const startAbortRef = useRef<AbortController | null>(null)
  // The vp_token the wallet produced, kept so a `request` replayed by
  // the relay after a reconnect re-sends the proof instead of asking
  // the holder to approve again.
  const vpTokenRef = useRef<PresentationResponse | null>(null)
  // True once the verifier's request has been surfaced for consent —
  // guards against a replayed `request` re-opening the consent screen.
  const requestSeenRef = useRef(false)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  // Compute the wallet's match summary as soon as the verifier's
  // request arrives. Pure-local; drives the consent UI's per-card
  // breakdown + the cross-credential linkage banner.
  useEffect(() => {
    let cancelled = false
    if (!request) {
      setMatchSummary(null)
      return () => {
        cancelled = true
      }
    }
    ;(async () => {
      try {
        const credentials = await storage.listCredentials()
        const dcql = buildDcql(request)
        const summary = matchDcqlAgainst(credentials, dcql)
        if (!cancelled) setMatchSummary(summary)
      } catch {
        if (!cancelled) setMatchSummary(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [request])

  const cleanup = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    // Abort in-flight createSession POST and wallet.present() so
    // neither resolves into a freshly-orphaned socket on a torn-down
    // hook instance.
    if (startAbortRef.current) {
      startAbortRef.current.abort()
      startAbortRef.current = null
    }
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    vpTokenRef.current = null
    requestSeenRef.current = false
    reconnectAttemptRef.current = 0
    sessionIdRef.current = null
    if (wsRef.current) {
      const ws = wsRef.current
      wsRef.current = null
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      // CLOSING is already in-flight; CLOSED needs no action.
      // OPEN / CONNECTING — issue close so the browser stops holding
      // the socket open in the network panel.
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close(1000, 'modal closed')
        } catch {
          /* defensive — close() spec doesn't throw but browsers vary */
        }
      }
    }
  }, [])

  // Bind the alive flag to the React mount cycle and tear down every
  // connection on unmount. The modal portal filters by `isOpen`, so
  // the component unmounts when the modal closes — making this the
  // single source of truth for "modal is gone, drop everything."
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      cleanup()
    }
  }, [cleanup])

  const connectWebSocketRef = useRef<((sessionId: string) => void) | null>(null)

  // Focus/visibility/connectivity-driven recovery. While the flow is
  // in a non-terminal state the OS may kill the WebSocket (screen
  // lock); on unlock / network return we reconnect to the still-alive
  // session. This is the PRIMARY recovery path — `onclose` quick
  // retries only cover a momentary blip.
  useEffect(() => {
    if (!NON_TERMINAL_STATES.has(state)) return

    const maybeReconnect = () => {
      const sessionId = sessionIdRef.current
      if (!sessionId) return
      if (!NON_TERMINAL_STATES.has(stateRef.current)) return
      const ws = wsRef.current
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return
      }
      reconnectAttemptRef.current = 0
      connectWebSocketRef.current?.(sessionId)
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') maybeReconnect()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', maybeReconnect)
    window.addEventListener('focus', maybeReconnect)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', maybeReconnect)
      window.removeEventListener('focus', maybeReconnect)
    }
  }, [state])

  const connectWebSocket = useCallback((sessionId: string) => {
    if (!aliveRef.current) return
    // Don't stack sockets. The existing socket is reusable only when
    // it's for the SAME sessionId — a stale socket pointing at a
    // previous session would otherwise short-circuit a legitimate new
    // connect for the current session.
    const existing = wsRef.current
    if (
      existing &&
      existing.url.includes(`/ws/presentation/${sessionId}`) &&
      (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
    ) {
      return
    }
    // Different sessionId, or socket in a CLOSING/CLOSED state — drop
    // it cleanly before we open the replacement so its onclose can't
    // fire after wsRef points at the new socket.
    if (existing) {
      existing.onopen = null
      existing.onmessage = null
      existing.onerror = null
      existing.onclose = null
      if (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING) {
        try {
          existing.close(1000, 'replaced')
        } catch {
          /* defensive */
        }
      }
    }
    const wsUrl = `${getWsBaseUrl()}/ws/presentation/${sessionId}?role=holder`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      reconnectAttemptRef.current = 0
      // The initial connect moves `creating` → `showing_qr`; a
      // reconnect mid-flow keeps whatever in-flight state we were in.
      if (stateRef.current === 'creating') setState('showing_qr')
      // If we already produced a proof, re-send it — the relay buffers
      // the last terminal message but a fresh socket may have missed it.
      if (vpTokenRef.current) {
        try {
          ws.send(
            JSON.stringify({
              type: 'response',
              payload: vpTokenRef.current,
            } satisfies WsMessage),
          )
        } catch {
          // best-effort; the relay's buffered copy still covers us
        }
      }
    }

    ws.onmessage = (event) => {
      try {
        const msg: WsMessage = JSON.parse(event.data)
        switch (msg.type) {
          case 'session_ready':
            // Don't yank a holder who is mid-consent/proving (or done)
            // back to `waiting` — only the pre-request states advance.
            if (stateRef.current === 'showing_qr' || stateRef.current === 'creating') {
              setState('waiting')
            }
            break
          case 'request': {
            // A replayed `request` on reconnect must be idempotent: if
            // consent was already shown (or a proof already produced),
            // don't re-prompt.
            if (requestSeenRef.current || vpTokenRef.current) break
            requestSeenRef.current = true
            setRequest(msg.payload as PresentationRequest)
            setState('consent')
            break
          }
          case 'peer_disconnected': {
            // Soft notice — the verifier dropped but the session is
            // alive. Keep waiting; do NOT error.
            const cur = stateRef.current
            if (cur === 'waiting' || cur === 'showing_qr') {
              setState('waiting')
            }
            break
          }
          case 'error': {
            const wsErr = msg.payload as { code: string; message: string }
            const cur = stateRef.current
            if (cur === 'complete' || cur === 'error' || cur === 'idle') break
            // Only a genuinely dead session is a hard failure.
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

    ws.onclose = () => {
      const cur = stateRef.current
      if (!NON_TERMINAL_STATES.has(cur)) return
      // Quick retries cover a brief blip. Beyond that the
      // visibility/focus/online listeners drive recovery — a session
      // is recoverable for its whole TTL, so we never hard-fail here.
      if (reconnectAttemptRef.current < QUICK_RECONNECT_ATTEMPTS) {
        reconnectAttemptRef.current += 1
        reconnectTimerRef.current = setTimeout(() => {
          connectWebSocket(sessionId)
        }, RECONNECT_DELAY_MS)
      }
    }
  }, [])

  useEffect(() => {
    connectWebSocketRef.current = connectWebSocket
  }, [connectWebSocket])

  const startPresentation = useCallback(async () => {
    cleanup()
    if (!aliveRef.current) return
    setError(null)
    setRequest(null)
    setSessionQr(null)
    setState('creating')

    // Bind an abort to the in-flight createSession POST so a fast
    // open→close (or a retry that races the previous attempt) tears
    // it down instead of letting it resolve into a freshly-orphaned
    // sessionId + WebSocket on an unmounted hook.
    const abort = new AbortController()
    startAbortRef.current = abort
    try {
      const session = await getPresentationApi().createSession(
        { createPresentationRequest: {} },
        { signal: abort.signal },
      )
      if (!aliveRef.current || abort.signal.aborted) return
      const { sessionId } = session
      sessionIdRef.current = sessionId

      // Compact QR engagement: only the WebSocket URL — the verifier
      // picks the nonce up from the `session_ready` payload over WS,
      // and the sessionId is the URL's last path segment. Shrinks the
      // QR from a ~400-char base64-JSON blob to a ~50-char URL.
      const engagement: SessionEngagement = {
        version: 1,
        ws: { url: `/ws/presentation/${sessionId}` },
      }
      setSessionQr(encodeSessionEngagement(engagement))
      connectWebSocket(sessionId)
    } catch (e) {
      if (abort.signal.aborted || !aliveRef.current) return
      if (e instanceof Error && e.name === 'AbortError') return
      console.error('[Presentation] Failed to start:', e)
      setError(e instanceof Error ? e.message : 'Failed to start presentation')
      setState('error')
    } finally {
      if (startAbortRef.current === abort) startAbortRef.current = null
    }
  }, [cleanup, connectWebSocket])

  const approve = useCallback(async () => {
    if (!request || !wsRef.current) {
      setError('No active request')
      setState('error')
      return
    }
    setState('generating')
    setAttestProgress(null)

    try {
      const wallet = new OwlWallet(
        storage,
        async (passkeyId, wrapped) => unwrapHolderKey(passkeyId, wrapped),
        async () => {
          const passkey = await storage.loadWebAuthnCredential()
          return passkey?.credentialId ?? null
        },
      )

      const dcql = buildDcql(request)
      // Fresh abort per attempt; previous attempts (if any) are already
      // settled by the time we re-enter this code path.
      abortRef.current?.abort()
      abortRef.current = new AbortController()
      const { vpToken, used } = await wallet.present({
        dcql,
        aud: request.verifierName,
        nonce: request.nonce,
        // Forward the OID4VP verifier `client_id` so the orchestrator
        // can fold it into the per-verifier salt for nationality_in /
        // resident_in attestations. Missing this would make the
        // orchestrator silently skip set-membership attestations and
        // the verifier would then reject the presentation with a
        // membership miss ("DCQL credential not satisfied").
        verifierId: request.verifierId,
        overrides,
        onAttestProgress: (event) => {
          attestProgressRef.current = event
          setAttestProgress(event)
        },
        signal: abortRef.current.signal,
      })

      attestProgressRef.current = null
      setAttestProgress(null)
      setState('sending')
      const response: PresentationResponse = {
        sessionId: request.sessionId,
        vpToken,
        used,
      }
      // Keep the proof so a reconnect (or a `request` replay) re-sends
      // it without re-prompting the holder.
      vpTokenRef.current = response
      const sock = wsRef.current
      if (sock && sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ type: 'response', payload: response } satisfies WsMessage))
      }
      // If the socket is mid-reconnect the relay-buffered copy plus the
      // `onopen` re-send cover delivery.
      setState('complete')
      // Drop the socket as soon as the verifier-side relay has the
      // response. Keeping it open for a grace window leaked one ghost
      // `?role=holder` socket per successful presentation in prod (one
      // row per session in devtools). The modal sits on the terminal
      // `complete` screen until the user dismisses; the next open is
      // a fresh hook mount with its own session.
      cleanup()
    } catch (e) {
      const sendOverWs = (msg: WsMessage) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          try {
            wsRef.current.send(JSON.stringify(msg))
          } catch {
            // best-effort
          }
        }
      }
      console.error('[Presentation] Presentation failed:', e)
      sendOverWs({ type: 'proof_failed', payload: { code: 'proof_failed' } })
      // Surface the real failure: the orchestrator/circuit/relay step
      // that threw, plus the underlying message. Generic "Presentation
      // failed." hides which substep needs the user's attention
      // (witness mismatch, network down, snapshot stale, …).
      const stageLabel = attestProgressStageLabel(attestProgressRef.current)
      const rawDetail =
        e instanceof Error ? (e.message ?? String(e)) : typeof e === 'string' ? e : String(e)
      const friendlyDetail = humanizeError(rawDetail)
      setError(stageLabel ? `${stageLabel}: ${friendlyDetail}` : friendlyDetail)
      setState('error')
    }
  }, [request, cleanup, overrides])

  const deny = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({ type: 'consent_denied', payload: null } satisfies WsMessage),
      )
    }
    // Tear down the WS + timers but keep the modal on a terminal
    // `denied` screen — switching to `idle` re-fires the modal's mount
    // effect (`if (isOpen && state === 'idle') startPresentation()`)
    // and the holder ends up in an infinite "Setting up secure
    // session…" loop.
    cleanup()
    setRequest(null)
    setSessionQr(null)
    setError(null)
    setState('denied')
  }, [cleanup])

  const cancel = useCallback(() => {
    // Notify the verifier the holder is bailing BEFORE we tear down
    // the WebSocket — otherwise the verifier is left waiting at the
    // "Holder selecting credentials…" / "Waiting for approval…" step
    // until the session TTL expires. `proof_failed` is the opaque
    // signal the verifier already handles as "presentation aborted".
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(
          JSON.stringify({
            type: 'proof_failed',
            payload: { code: 'proof_failed' },
          } satisfies WsMessage),
        )
      } catch {
        // best-effort — verifier will eventually time out the session
      }
    }
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
    matchSummary,
    overrides,
    setOverride,
    attestProgress,
    error,
    startPresentation,
    approve,
    deny,
    cancel,
  }
}
