import { useState, useCallback, useEffect, useRef } from 'react'
import { ScanLine, ClipboardPaste, Copy, RefreshCw, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { QRCodeSVG } from 'qrcode.react'
import { QrScanner } from './components/QrScanner'
import { PasteInput } from './components/PasteInput'
import { PredicateSelector, type CampaignRequest } from './components/PredicateSelector'
import { VerificationResult } from './components/VerificationResult'
import { VerificationHistory } from './components/VerificationHistory'
import { VerifierHeader } from './components/VerifierHeader'
import { VerifierTabs } from './components/VerifierTabs'
import { VerificationSteps } from './components/VerificationSteps'
import { RevocationLookup } from './components/RevocationLookup'
import { RevocationsList } from './components/RevocationsList'
import { TrustedIssuersList } from './components/TrustedIssuersList'
import { checkHealthWithRetry, decideServiceOnline } from './health-monitor'
import {
  getVerifierApiKey,
  verifyToken,
  verifyDcqlVpToken,
  healthCheck,
  type VerifyResult,
} from './api'
import { Button } from '@owlid/ui/components/ui/button'
import { Card, CardContent } from '@owlid/ui/components/ui/card'
import { FaqDialog } from './components/FaqDialog'
import {
  decodeSessionEngagement,
  isPresentationEngagement,
  isSdJwtVc,
  owlCredentialQuery,
  resolveWsUrl,
  sessionIdFromWsUrl,
  type DcqlRequest,
  type OwlPredicate,
  type SessionEngagement,
  type PresentationRequest,
  type PresentationResponse,
  type WsMessage,
  type WsError,
} from '@owlid/sdk'
import type { PredicateInfo } from './api'
import type { Step, Tab } from './flow-types'
import { addHistory } from './history-store'
import { friendlyCheckLabel } from './dcql-labels'

/** Persist one verification to the IndexedDB-backed history log. */
function recordHistory(result: VerifyResult, campaign?: string | null): void {
  const checks = Object.keys(result.subjects ?? {})
    .filter((k) => !['issuerKey', 'ownerKey', 'rootHash', 'salt'].includes(k))
    .map(friendlyCheckLabel)
  void addHistory({
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    valid: result.valid,
    checks,
    campaign: campaign ?? undefined,
    error: result.error ?? undefined,
  }).catch(() => {
    /* history is best-effort — never block the verification UI */
  })
}

/**
 * Verification flow:
 *
 * Two entry paths share this state machine:
 *   - Session protocol:
 *     idle -> scanning -> connecting -> selecting -> waiting -> verifying -> result
 *     Holder shows OWLP: QR -> verifier scans, connects WS, picks claims,
 *     holder approves, verifier receives the SD-JWT VC presentation and verifies.
 *   - Direct verify:
 *     idle -> scanning|paste -> verifying -> result
 *     Holder shows an SD-JWT VC presentation QR (or pastes it); verifier
 *     verifies directly via `OwlVerifier.verify(presentation, challenge)`.
 */
/** Per-predicate verifier input for the generic age predicates: a
 *  threshold for `age:gte`, an inclusive `{min,max}` for `age:range`. */
export type PredicateParamInput =
  | { threshold: number }
  | { min: number; max: number }
  /** Verifier-supplied allowed country set for `nationality:in` /
   *  `residency:in` (ISO 3166-1 alpha-2, ≤16 codes). */
  | { countries: string[] }

function buildDcqlFromPredicates(
  predicates: PredicateInfo[],
  params?: Map<string, PredicateParamInput>,
): DcqlRequest {
  // OID4VP 1.0 §6 — every credential query carries an OwlID
  // `owl_predicate` extension. `claims: []` is the spec-strict signal
  // that no plaintext disclosure is required; the wallet honours the
  // extension and substitutes an on-chain Midnight attestation check
  // for the disclosure.
  const credentials = predicates
    // `personhood:unique` is a scoped predicate — its on-chain
    // nullifier is meaningless without an (epoch, app_id). It enters
    // the DCQL only via the campaign block in buildDcqlRequest, never
    // as a plain query.
    .filter((p) => p.id !== 'personhood:unique')
    .map((p) => {
      const id = p.id.replace(/[^a-zA-Z0-9_-]/g, '_')
      const input = params?.get(p.id)
      const predicate = predicateForRoute(p, input)
      if (!predicate) {
        // Predicate has no Midnight mapping — emit a spec-strict empty
        // query so the wallet's owl_predicate lookup returns
        // undefined and the credential is treated as unsatisfiable.
        return owlCredentialQuery(id, {
          kind: 'kyc_gte',
          threshold: Number.MAX_SAFE_INTEGER,
        })
      }
      return owlCredentialQuery(id, predicate)
    })
  return { credentials }
}

/** Translate a registry predicate + verifier input into the
 *  `OwlPredicate` shape the wallet dispatches on. Returns null when
 *  the predicate has no Midnight mapping (legacy registry entries). */
function predicateForRoute(
  p: PredicateInfo,
  input: PredicateParamInput | undefined,
): OwlPredicate | null {
  switch (p.route) {
    case 'age_over':
      if (input && 'threshold' in input) return { kind: 'age_gte', threshold: input.threshold }
      return null
    case 'age_range':
      if (input && 'min' in input) return { kind: 'age_range', min: input.min, max: input.max }
      return null
    case 'verification_level': {
      const threshold = input && 'threshold' in input ? input.threshold : 1
      return { kind: 'kyc_gte', threshold }
    }
    case 'nationality_in':
      if (input && 'countries' in input)
        return { kind: 'nationality_in', countries: input.countries }
      return null
    case 'resident_in':
      if (input && 'countries' in input) return { kind: 'residency_in', countries: input.countries }
      return null
    case 'email_verified':
      return { kind: 'email_verified' }
    default:
      return null
  }
}

/** SHA-256 of a string as lowercase hex. */
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Build the DCQL request, appending a `unique_person` claim when the
 * operator set a campaign. `app_id` scopes the nullifier to the
 * campaign, `epoch` to the round — same (campaign, round) blocks a
 * second claim by the same human; a new round opens a fresh claim.
 */
async function buildDcqlRequest(
  predicates: PredicateInfo[],
  campaign?: CampaignRequest,
  params?: Map<string, PredicateParamInput>,
): Promise<DcqlRequest> {
  // Personhood is only ever requested WITH a scope — there is no
  // unscoped path. Selecting it without a campaign is a hard error,
  // never a silently-dropped claim.
  const wantsPersonhood = predicates.some((p) => p.id === 'personhood:unique')
  if (wantsPersonhood && !campaign) {
    throw new Error(
      'Personhood verification requires a campaign — set a campaign (app id + round) ' +
        'to scope the uniqueness nullifier.',
    )
  }
  const base = buildDcqlFromPredicates(predicates, params)
  if (!campaign) return base
  const appId = await sha256Hex(`owlid:campaign:${campaign.campaignId}`)
  const epoch = await sha256Hex(`owlid:round:${campaign.campaignId}#${campaign.round}`)
  return {
    credentials: [
      ...base.credentials,
      owlCredentialQuery('unique_person', {
        kind: 'unique_personhood',
        epoch,
        appId,
      }),
    ],
  }
}

const TAB_STORAGE_KEY = 'owlid-verifier-tab'

// Steps from which a transport drop is recoverable — the session is in
// flight but the verification has not yet resolved.
const RECOVERABLE_STEPS: ReadonlySet<Step> = new Set(['connecting', 'selecting', 'waiting'])

// Quick retries cover a momentary blip; the focus/visibility/online
// listeners are the primary recovery path for a longer outage.
const QUICK_RECONNECT_ATTEMPTS = 2
const RECONNECT_DELAY_MS = 1500

function loadTab(): Tab {
  if (typeof localStorage === 'undefined') return 'verify'
  const saved = localStorage.getItem(TAB_STORAGE_KEY)
  return saved === 'verify' || saved === 'issuers' || saved === 'revocations' || saved === 'history'
    ? saved
    : 'verify'
}

export function App() {
  const [tab, setTab] = useState<Tab>(loadTab)
  const [step, setStep] = useState<Step>('idle')
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [serviceOnline, setServiceOnline] = useState<boolean | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const [engagement, setEngagement] = useState<SessionEngagement | null>(null)
  const [errorMessage, setErrorMessage] = useState<string>('')
  // Campaign name when the current request is a unique-personhood check;
  // surfaced on the result screen.
  const [campaignLabel, setCampaignLabel] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const stepRef = useRef<Step>('idle')
  // Engagement of the in-flight session — kept so the focus/online
  // recovery listeners can reconnect to the same session.
  const engagementRef = useRef<SessionEngagement | null>(null)
  // Quick-retry counter for an immediate `onclose` blip.
  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // True once the verifier has sent its `request` — a replayed
  // `request`/`response` after a reconnect is then handled correctly.
  const requestSentRef = useRef(false)
  const connectToSessionRef = useRef<((eng: SessionEngagement) => void) | null>(null)
  // The exact DCQL sent to the holder — replayed into the verify call
  // so the server re-checks every predicate / personhood claim.
  const sentDcqlRef = useRef<DcqlRequest | null>(null)
  // Session nonce. Old `OWLP:` QRs carried it inline; new `OWLP1:` QRs
  // do not, so the verifier picks it up from the server's
  // `session_ready` WS payload instead. Stored in a ref because the
  // KB-JWT verify call (driven by the `response` handler) needs it
  // without re-rendering the component on receipt.
  const nonceRef = useRef<string | null>(null)
  // Campaign name of the in-flight request — read when logging history
  // (a ref avoids stale-closure issues across the WS callback chain).
  const campaignRef = useRef<string | null>(null)
  const transitionStep = useCallback((s: Step) => {
    stepRef.current = s
    setStep(s)
  }, [])

  const goToError = useCallback(
    (message: string) => {
      const cur = stepRef.current
      if (cur === 'verifying' || cur === 'result' || cur === 'error') return
      setErrorMessage(message)
      transitionStep('error')
      setEngagement(null)
    },
    [transitionStep],
  )

  // Consecutive failed health checks. The banner only flips to "offline"
  // once this crosses the threshold, so a single transient blip on an
  // up backend doesn't flap the UI / disable "Scan QR" (GH #14).
  const healthFailuresRef = useRef(0)
  useEffect(() => {
    let cancelled = false
    const runCheck = async () => {
      const healthy = await checkHealthWithRetry(healthCheck)
      if (cancelled) return
      healthFailuresRef.current = healthy ? 0 : healthFailuresRef.current + 1
      setServiceOnline((prev) => decideServiceOnline(prev, healthy, healthFailuresRef.current))
    }
    void runCheck()
    const interval = setInterval(runCheck, 30000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [])

  const closeWs = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    engagementRef.current = null
    requestSentRef.current = false
    reconnectAttemptRef.current = 0
    wsRef.current?.close()
    wsRef.current = null
  }, [])

  // Focus/visibility/connectivity-driven recovery. While a session is
  // in flight the OS may kill the WebSocket (screen lock, app
  // backgrounded); on unlock / network return we reconnect to the
  // still-alive session instead of failing.
  useEffect(() => {
    if (!RECOVERABLE_STEPS.has(step)) return

    const maybeReconnect = () => {
      const eng = engagementRef.current
      if (!eng) return
      if (!RECOVERABLE_STEPS.has(stepRef.current)) return
      const ws = wsRef.current
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return
      }
      reconnectAttemptRef.current = 0
      connectToSessionRef.current?.(eng)
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
  }, [step])

  const connectToSession = useCallback(
    (eng: SessionEngagement) => {
      if (!eng.ws) {
        toast.error('No WebSocket transport in engagement')
        setStep('idle')
        return
      }
      // Don't stack sockets — focus/online/onclose can all fire at once.
      const existing = wsRef.current
      if (
        existing &&
        (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
      ) {
        return
      }
      engagementRef.current = eng
      setEngagement(eng)
      // A reconnect keeps the in-flight step; only the first connect
      // starts at `connecting`.
      if (!RECOVERABLE_STEPS.has(stepRef.current)) {
        transitionStep('connecting')
        setStatusMessage('Connecting to session…')
      }

      const baseUrl = resolveWsUrl(eng.ws.url)
      let apiKey: string
      try {
        apiKey = getVerifierApiKey()
      } catch (err) {
        goToError(err instanceof Error ? err.message : 'Verifier API key is invalid.')
        return
      }
      const fullUrl = baseUrl.includes('?')
        ? `${baseUrl}&role=verifier&apiKey=${encodeURIComponent(apiKey)}`
        : `${baseUrl}?role=verifier&apiKey=${encodeURIComponent(apiKey)}`
      const ws = new WebSocket(fullUrl)
      wsRef.current = ws

      ws.onopen = () => {
        reconnectAttemptRef.current = 0
        // If the request was already sent, stay on `waiting` — the
        // relay replays a buffered `response` if the holder finished
        // while we were away. Only a fresh connect goes to `selecting`.
        if (!requestSentRef.current && stepRef.current === 'connecting') {
          transitionStep('selecting')
        } else if (requestSentRef.current && stepRef.current !== 'verifying') {
          setStatusMessage('Waiting for holder approval…')
        }
      }
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as WsMessage
          handleWsMessage(msg, eng)
        } catch {
          toast.error('Received malformed message from server')
        }
      }
      ws.onerror = () => {
        // Don't hard-fail on a transient socket error — `onclose` runs
        // next and drives reconnect.
        console.error('[Verifier] WebSocket error')
      }
      ws.onclose = (event) => {
        if (event.code === 1000) return
        if (!RECOVERABLE_STEPS.has(stepRef.current)) return
        // Quick retries cover a blip; beyond that the
        // focus/visibility/online listeners recover for the whole TTL.
        if (reconnectAttemptRef.current < QUICK_RECONNECT_ATTEMPTS) {
          reconnectAttemptRef.current += 1
          setStatusMessage('Connection lost — reconnecting…')
          reconnectTimerRef.current = setTimeout(() => {
            connectToSessionRef.current?.(eng)
          }, RECONNECT_DELAY_MS)
        } else {
          setStatusMessage('Waiting to reconnect…')
        }
      }
    },
    [goToError, transitionStep],
  )

  useEffect(() => {
    connectToSessionRef.current = connectToSession
  }, [connectToSession])

  const handleWsMessage = useCallback(
    (msg: WsMessage, eng: SessionEngagement) => {
      switch (msg.type) {
        case 'session_ready': {
          // Server delivers the session nonce in the ready payload so
          // the QR doesn't have to. Old QRs that still ship the nonce
          // inline are honoured below as a fallback.
          const ready = (msg.payload as { nonce?: string } | null) ?? {}
          if (typeof ready.nonce === 'string' && ready.nonce.length > 0) {
            nonceRef.current = ready.nonce
          }
          setStep('selecting')
          break
        }
        case 'response': {
          const response = msg.payload as PresentationResponse
          const vpToken = response?.vpToken ?? {}
          if (Object.keys(vpToken).length === 0) {
            goToError('Holder sent an empty response.')
            closeWs()
            return
          }
          stepRef.current = 'verifying'
          // Prefer the nonce the server pushed via `session_ready` over
          // anything the legacy engagement carried.
          const nonce = nonceRef.current ?? eng.nonce ?? ''
          handleVerifyPresentation(vpToken, nonce)
          break
        }
        case 'consent_denied': {
          const err = msg.payload as WsError | null
          goToError(err?.message || 'The holder declined this verification request.')
          closeWs()
          break
        }
        case 'proof_failed': {
          stepRef.current = 'result'
          const reason = 'Holder could not generate a valid proof.'
          setResult({ valid: false, error: reason })
          setStep('result')
          recordHistory({ valid: false, error: reason }, campaignRef.current)
          toast.error('Verification failed', { description: reason })
          closeWs()
          break
        }
        case 'peer_disconnected': {
          // Soft notice — the holder's socket dropped but the session
          // is alive until its TTL. Keep waiting; the holder's app
          // reconnects on unlock and the relay replays buffered state.
          if (RECOVERABLE_STEPS.has(stepRef.current)) {
            setStatusMessage('Holder disconnected — waiting for them to reconnect…')
          }
          break
        }
        case 'error': {
          // Only a genuinely dead/expired session is a hard failure.
          // Transport drops now arrive as `peer_disconnected`.
          const wsErr = msg.payload as WsError
          goToError(wsErr?.message || 'Session error.')
          break
        }
        default:
          break
      }
    },
    [closeWs, goToError],
  )

  const handleSendRequest = useCallback(
    async (
      predicates: PredicateInfo[],
      verifierName: string,
      campaign?: CampaignRequest,
      params?: Map<string, PredicateParamInput>,
    ) => {
      if (!engagement?.ws || !wsRef.current) {
        toast.error('Not connected to session')
        setStep('idle')
        return
      }
      const dcql = await buildDcqlRequest(predicates, campaign, params)
      sentDcqlRef.current = dcql
      campaignRef.current = campaign?.campaignId ?? null
      setCampaignLabel(campaign?.campaignId ?? null)
      const sessionId = engagement.ws.sessionId ?? sessionIdFromWsUrl(engagement.ws.url) ?? ''
      const nonce = nonceRef.current ?? engagement.nonce ?? ''
      const request: PresentationRequest = {
        sessionId,
        verifierName,
        // OID4VP `client_id` — this app's stable identity in the verifier
        // trust model. Folded into the on-chain attestation key for
        // nationality_in / resident_in predicates so two verifiers asking
        // the same set produce distinct keys. Browser origin is the most
        // truthful stable identifier the deployed SPA can self-derive.
        verifierId: window.location.origin,
        dcql,
        nonce,
        timestamp: Date.now(),
      }
      wsRef.current.send(JSON.stringify({ type: 'request', payload: request } satisfies WsMessage))
      requestSentRef.current = true
      transitionStep('waiting')
      setStatusMessage('Waiting for holder approval…')
    },
    [engagement, transitionStep],
  )

  const handleVerifyPresentation = useCallback(
    async (vpToken: Record<string, string[]>, nonce: string) => {
      transitionStep('verifying')
      setStatusMessage('Verifying proof…')
      try {
        const verifyResult = await verifyDcqlVpToken(
          vpToken,
          nonce,
          sentDcqlRef.current ?? undefined,
          // Must match the verifierId the wallet used when attesting —
          // same self-derived origin we sent in the PresentationRequest.
          window.location.origin,
        )
        setResult(verifyResult)
        transitionStep('result')
        recordHistory(verifyResult, campaignRef.current)
        if (verifyResult.valid) {
          toast.success('Proof verified')
        } else {
          toast.error('Verification failed', {
            description: verifyResult.error || 'The proof is invalid',
          })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Verification request failed'
        const failResult: VerifyResult = { valid: false, error: message }
        setResult(failResult)
        transitionStep('result')
        recordHistory(failResult, campaignRef.current)
        toast.error('Verification error', { description: message })
      } finally {
        closeWs()
      }
    },
    [closeWs, transitionStep],
  )

  const handleQrScan = useCallback(
    (data: string) => {
      if (isPresentationEngagement(data)) {
        const eng = decodeSessionEngagement(data)
        if (!eng) {
          toast.error('Invalid engagement QR code')
          setStep('idle')
          return
        }
        connectToSession(eng)
      } else if (isSdJwtVc(data)) {
        toast.info('SD-JWT VC detected (manual flow)', {
          description: 'Use "Manual" for challenge-based flow, or paste the credential below.',
        })
        setStep('idle')
      } else {
        toast.error('Unrecognized QR code', {
          description: 'Expected an Owl ID presentation or SD-JWT VC.',
        })
        setStep('idle')
      }
    },
    [connectToSession],
  )

  const [manualChallenge, setManualChallenge] = useState<string | null>(null)
  const startManualVerification = useCallback(async () => {
    try {
      const { getChallenge } = await import('./api')
      const resp = await getChallenge()
      setManualChallenge(resp.challenge)
      setStep('manual-challenge')
      setResult(null)
    } catch {
      toast.error('Failed to get challenge from server')
    }
  }, [])

  const handleManualVerify = useCallback(
    async (sdJwtVc: string) => {
      const trimmed = sdJwtVc.trim()
      if (!trimmed) {
        toast.error('Empty credential')
        return
      }
      if (!isSdJwtVc(trimmed)) {
        toast.error('Invalid credential format', {
          description: 'Expected an SD-JWT VC (eyJ…~D1~…~).',
        })
        return
      }
      if (!manualChallenge) {
        toast.error('No challenge — start a new verification')
        return
      }
      setStep('verifying')
      setStatusMessage('Verifying credential…')
      try {
        const verifyResult = await verifyToken(trimmed, manualChallenge)
        setResult(verifyResult)
        setStep('result')
        recordHistory(verifyResult)
        if (verifyResult.valid) toast.success('Credential verified')
        else
          toast.error('Verification failed', {
            description: verifyResult.error || 'Credential is invalid',
          })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Verification request failed'
        setResult({ valid: false, error: message })
        setStep('result')
        toast.error('Verification error', { description: message })
      } finally {
        setManualChallenge(null)
      }
    },
    [manualChallenge],
  )

  const handleReset = useCallback(() => {
    setResult(null)
    setStep('idle')
    setEngagement(null)
    setManualChallenge(null)
    setStatusMessage('')
    setErrorMessage('')
    setCampaignLabel(null)
    sentDcqlRef.current = null
    campaignRef.current = null
    closeWs()
  }, [closeWs])

  const handleCancelSelecting = useCallback(() => {
    setStep('idle')
    setEngagement(null)
    closeWs()
  }, [closeWs])

  return (
    <div className="min-h-dvh flex flex-col bg-background text-foreground">
      <VerifierHeader serviceOnline={serviceOnline} />

      <main className="flex-1 px-4 py-6">
        <div className="mx-auto max-w-3xl space-y-5">
          <VerifierTabs
            active={tab}
            onChange={(t) => {
              setTab(t)
              if (typeof localStorage !== 'undefined') localStorage.setItem(TAB_STORAGE_KEY, t)
            }}
          />

          {tab === 'verify' && (
            <VerifyTabContent
              step={step}
              setStep={setStep}
              serviceOnline={serviceOnline}
              statusMessage={statusMessage}
              engagement={engagement}
              result={result}
              campaignLabel={campaignLabel}
              errorMessage={errorMessage}
              manualChallenge={manualChallenge}
              startManualVerification={startManualVerification}
              handleQrScan={handleQrScan}
              handleSendRequest={handleSendRequest}
              handleCancelSelecting={handleCancelSelecting}
              handleManualVerify={handleManualVerify}
              handleReset={handleReset}
            />
          )}

          {tab === 'issuers' && <TrustedIssuersList />}

          {tab === 'revocations' && (
            <div className="space-y-4">
              <RevocationLookup />
              <RevocationsList />
            </div>
          )}

          {tab === 'history' && <VerificationHistory />}
        </div>
      </main>

      <footer className="border-t border-white/5 px-4 py-3 flex items-center justify-center gap-3">
        <p className="text-[11px] text-muted-foreground tracking-wider uppercase">
          Owl ID · Private identity checks
        </p>
        <span className="text-muted-foreground/40">·</span>
        <div className="text-[11px] text-muted-foreground">
          <FaqDialog />
        </div>
      </footer>
    </div>
  )
}

// -------------------------------------------------------------------------
// Verify tab content (kept inline so the state machine stays in App)
// -------------------------------------------------------------------------

interface VerifyTabContentProps {
  step: Step
  setStep: (s: Step) => void
  serviceOnline: boolean | null
  statusMessage: string
  engagement: SessionEngagement | null
  result: VerifyResult | null
  campaignLabel: string | null
  errorMessage: string
  manualChallenge: string | null
  startManualVerification: () => void
  handleQrScan: (data: string) => void
  handleSendRequest: (
    predicates: PredicateInfo[],
    verifierName: string,
    campaign?: CampaignRequest,
    params?: Map<string, PredicateParamInput>,
  ) => void
  handleCancelSelecting: () => void
  handleManualVerify: (sdJwtVc: string) => void
  handleReset: () => void
}

function VerifyTabContent({
  step,
  setStep,
  serviceOnline,
  statusMessage,
  result,
  campaignLabel,
  errorMessage,
  manualChallenge,
  startManualVerification,
  handleQrScan,
  handleSendRequest,
  handleCancelSelecting,
  handleManualVerify,
  handleReset,
}: VerifyTabContentProps) {
  const showSteps =
    step === 'connecting' || step === 'waiting' || step === 'verifying' || step === 'error'

  return (
    <div className="space-y-5">
      {showSteps && (
        <Card className="border-white/10 bg-zinc-900/50">
          <CardContent className="space-y-3 py-5">
            <div>
              <h3 className="text-base font-semibold">Verification in progress</h3>
              <p className="text-xs text-muted-foreground mt-1">
                {statusMessage || 'Hold on while the holder builds and submits their proof.'}
              </p>
            </div>
            <VerificationSteps currentStep={step} errored={step === 'error'} />
            {step === 'error' && (
              <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 text-red-400 shrink-0" />
                <p className="text-sm text-red-300 flex-1">
                  {errorMessage || 'The session ended before completing.'}
                </p>
              </div>
            )}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleReset}>
                Cancel
              </Button>
              {step === 'error' && (
                <Button
                  size="sm"
                  onClick={() => {
                    handleReset()
                    setStep('scanning')
                  }}
                >
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                  Try again
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'result' && result && (
        <VerificationResult
          result={result}
          onReset={handleReset}
          campaign={campaignLabel ?? undefined}
        />
      )}

      {step === 'idle' && !result && (
        <Card className="border-white/10 bg-zinc-900/50">
          <CardContent className="space-y-4 py-6">
            <div className="text-center space-y-2 py-2">
              <div className="w-12 h-12 mx-auto rounded-full bg-white/5 border border-white/10 flex items-center justify-center">
                <ScanLine className="w-6 h-6 text-muted-foreground" />
              </div>
              <h2 className="text-xl font-semibold">Verify a credential</h2>
              <p className="text-sm text-muted-foreground">
                Scan the holder's QR code to start a verification session, or use the
                challenge-paste flow when you don't have a camera.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Button
                size="lg"
                onClick={() => setStep('scanning')}
                disabled={!serviceOnline}
                className="h-auto py-4 flex-col gap-1"
              >
                <ScanLine className="w-5 h-5" />
                <span>Scan QR</span>
                <span className="text-[11px] font-normal opacity-80">Live session</span>
              </Button>
              <Button
                size="lg"
                variant="outline"
                onClick={startManualVerification}
                disabled={!serviceOnline}
                className="h-auto py-4 flex-col gap-1"
              >
                <ClipboardPaste className="w-5 h-5" />
                <span>Manual</span>
                <span className="text-[11px] font-normal opacity-80">Challenge + paste</span>
              </Button>
            </div>

            {!serviceOnline && serviceOnline !== null && (
              <p className="text-center text-xs text-red-400">
                Verification service is offline. Check the backend before continuing.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {step === 'scanning' && (
        <Card className="border-white/10 bg-zinc-900/50">
          <CardContent className="space-y-4 py-5">
            <div>
              <h3 className="text-base font-semibold">Scan the holder's QR</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Point the camera at the QR on the holder's wallet to open a verification session.
              </p>
            </div>
            <QrScanner
              onScan={handleQrScan}
              onCancel={() => setStep('idle')}
              caption="Point the camera at the holder's presentation QR"
            />
            <Button variant="outline" size="sm" onClick={() => setStep('idle')}>
              Cancel
            </Button>
          </CardContent>
        </Card>
      )}

      {step === 'selecting' && (
        <PredicateSelector onSubmit={handleSendRequest} onCancel={handleCancelSelecting} />
      )}

      {step === 'manual-challenge' && manualChallenge && (
        <Card className="border-white/10 bg-zinc-900/50">
          <CardContent className="space-y-4 py-6">
            <div className="text-center space-y-1">
              <h3 className="font-semibold">Challenge-based verification</h3>
              <p className="text-sm text-muted-foreground">
                Have the holder scan this QR (or copy the challenge text) and sign it, then scan or
                paste their credential.
              </p>
            </div>

            <div className="bg-white p-4 rounded-xl flex justify-center">
              <QRCodeSVG value={manualChallenge} size={220} />
            </div>

            <div className="space-y-1 rounded-md border border-white/10 bg-zinc-950 p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">Challenge (5 min expiry)</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto px-2 py-1"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(manualChallenge)
                      .then(() => toast.success('Challenge copied'))
                      .catch(() => toast.error('Copy failed'))
                  }}
                >
                  <Copy className="w-3.5 h-3.5 mr-1" />
                  Copy
                </Button>
              </div>
              <p className="text-xs font-mono text-muted-foreground break-all select-all">
                {manualChallenge}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Button
                variant="outline"
                className="h-auto flex-col gap-2 py-4"
                onClick={() => setStep('manual-scan')}
              >
                <ScanLine className="w-6 h-6 text-muted-foreground" />
                <span className="text-sm font-medium">Scan credential</span>
              </Button>
              <Button
                variant="outline"
                className="h-auto flex-col gap-2 py-4"
                onClick={() => setStep('manual-paste')}
              >
                <ClipboardPaste className="w-6 h-6 text-muted-foreground" />
                <span className="text-sm font-medium">Paste credential</span>
              </Button>
            </div>

            <Button variant="ghost" className="w-full" onClick={handleReset}>
              Cancel
            </Button>
          </CardContent>
        </Card>
      )}

      {step === 'manual-scan' && (
        <Card className="border-white/10 bg-zinc-900/50">
          <CardContent className="space-y-4 py-5">
            <div>
              <h3 className="text-base font-semibold">Scan the credential</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Point the camera at the holder's SD-JWT VC presentation QR.
              </p>
            </div>
            <QrScanner
              onScan={handleManualVerify}
              onCancel={() => setStep('manual-challenge')}
              caption="Point the camera at the credential QR"
            />
            <Button variant="outline" size="sm" onClick={() => setStep('manual-challenge')}>
              Back
            </Button>
          </CardContent>
        </Card>
      )}

      {step === 'manual-paste' && (
        <PasteInput onSubmit={handleManualVerify} onCancel={() => setStep('manual-challenge')} />
      )}
    </div>
  )
}
