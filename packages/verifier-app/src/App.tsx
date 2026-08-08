import { useState, useCallback, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import {
  getVerifierApiKey,
  verifyDcqlVpToken,
  healthCheck,
  listPredicates,
  type VerifyResult,
  type PredicateInfo,
} from './api'
import { checkHealthWithRetry, decideServiceOnline } from './health-monitor'
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
import type { Step } from './flow-types'
import { addHistory } from './history-store'
import { friendlyCheckLabel } from './dcql-labels'
import { friendlyVerifyError } from './error-messages'
import { CHECK_REQUESTS } from './design-data'
import {
  IconHistory,
  IconMenu,
  IconScan,
  IconSettings,
  IconShield,
  IconShieldAlert,
  OwlMark,
} from './icons'
import { HomeScreen } from './screens/HomeScreen'
import { ScanScreen } from './screens/ScanScreen'
import { WaitingScreen } from './screens/WaitingScreen'
import { VerifiedScreen, FailedScreen, DeniedScreen } from './screens/ResultScreens'
import { HistoryScreen } from './screens/HistoryScreen'
import { SettingsScreen, type VerifierSettings } from './screens/SettingsScreen'
import { TrustedIssuersList } from './components/TrustedIssuersList'
import { RevocationLookup } from './components/RevocationLookup'
import { RevocationsList } from './components/RevocationsList'
import { FaqDialog } from './components/FaqDialog'
import { Eyebrow } from './components/common'

/** Per-predicate verifier input for the generic age predicates: a
 *  threshold for `age:gte`, an inclusive `{min,max}` for `age:range`. */
export type PredicateParamInput =
  | { threshold: number }
  | { min: number; max: number }
  /** Verifier-supplied allowed country set for `nationality:in` /
   *  `residency:in` (ISO 3166-1 alpha-2). */
  | { countries: string[] }

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

function buildDcqlFromPredicates(
  predicates: PredicateInfo[],
  params?: Map<string, PredicateParamInput>,
): DcqlRequest {
  const credentials = predicates
    .filter((p) => p.id !== 'personhood:unique')
    .map((p) => {
      const id = p.id.replace(/[^a-zA-Z0-9_-]/g, '_')
      const input = params?.get(p.id)
      const predicate = predicateForRoute(p, input)
      if (!predicate) {
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
 *  `OwlPredicate` shape the wallet dispatches on. */
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

/** Resolve the configure-first selection (design check ids) into the
 *  real registry predicates + the verifier inputs the wallet checks. */
function buildSelectedRequest(
  registry: PredicateInfo[],
  selected: string[],
): { predicates: PredicateInfo[]; params: Map<string, PredicateParamInput> } {
  const params = new Map<string, PredicateParamInput>()
  const seen = new Set<string>()
  const predicates: PredicateInfo[] = []
  for (const checkId of selected) {
    const req = CHECK_REQUESTS[checkId]
    if (!req) continue
    const info = registry.find((p) => p.id === req.predicateId)
    if (!info) continue
    if (!seen.has(info.id)) {
      predicates.push(info)
      seen.add(info.id)
    }
    if (req.param) params.set(req.predicateId, req.param)
  }
  return { predicates, params }
}

// Steps from which a transport drop is recoverable.
const RECOVERABLE_STEPS: ReadonlySet<Step> = new Set(['connecting', 'selecting', 'waiting'])
const QUICK_RECONNECT_ATTEMPTS = 2
const RECONNECT_DELAY_MS = 1500

type NavView = 'verify' | 'history' | 'settings' | 'issuers' | 'revocations'
type Outcome = 'denied' | null

const VIEW_STORAGE_KEY = 'owlid-verifier-view'
const SETTINGS_STORAGE_KEY = 'owlid-verifier-settings'
const NAME_STORAGE_KEY = 'owlid-verifier-name'
const HANDLE_STORAGE_KEY = 'owlid-verifier-handle'

const DEFAULT_SETTINGS: VerifierSettings = {
  autoReset: true,
  sound: false,
  history: true,
  pin: false,
}

function loadString(key: string, fallback: string): string {
  if (typeof localStorage === 'undefined') return fallback
  return localStorage.getItem(key) ?? fallback
}
function loadSettings(): VerifierSettings {
  if (typeof localStorage === 'undefined') return DEFAULT_SETTINGS
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}
function loadView(): NavView {
  const v = loadString(VIEW_STORAGE_KEY, 'verify')
  return (['verify', 'history', 'settings', 'issuers', 'revocations'] as const).includes(
    v as NavView,
  )
    ? (v as NavView)
    : 'verify'
}

export function App() {
  const [view, setViewState] = useState<NavView>(loadView)
  const [step, setStep] = useState<Step>('idle')
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [outcome, setOutcome] = useState<Outcome>(null)
  const [serviceOnline, setServiceOnline] = useState<boolean | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const [engagement, setEngagement] = useState<SessionEngagement | null>(null)
  const [errorMessage, setErrorMessage] = useState<string>('')

  // Configure-first session being built on the Home screen.
  const [displayName, setDisplayName] = useState(() => loadString(NAME_STORAGE_KEY, ''))
  const [handle, setHandle] = useState(() => loadString(HANDLE_STORAGE_KEY, ''))
  const [selected, setSelected] = useState<string[]>(['age_18'])
  const [activePreset, setActivePreset] = useState<string | null>('bar')
  const [settings, setSettingsState] = useState<VerifierSettings>(loadSettings)
  const [registry, setRegistry] = useState<PredicateInfo[] | null>(null)

  const setView = useCallback((v: NavView) => {
    setViewState(v)
    if (typeof localStorage !== 'undefined') localStorage.setItem(VIEW_STORAGE_KEY, v)
  }, [])
  const setSettings = useCallback((s: VerifierSettings) => {
    setSettingsState(s)
    if (typeof localStorage !== 'undefined')
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(s))
  }, [])

  // Persist identity fields.
  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(NAME_STORAGE_KEY, displayName)
  }, [displayName])
  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(HANDLE_STORAGE_KEY, handle)
  }, [handle])

  const wsRef = useRef<WebSocket | null>(null)
  const stepRef = useRef<Step>('idle')
  const engagementRef = useRef<SessionEngagement | null>(null)
  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestSentRef = useRef(false)
  const connectToSessionRef = useRef<((eng: SessionEngagement) => void) | null>(null)
  const sentDcqlRef = useRef<DcqlRequest | null>(null)
  const nonceRef = useRef<string | null>(null)
  // Mirrors for the WS callback chain (avoid stale closures).
  const selectedRef = useRef<string[]>(selected)
  const displayNameRef = useRef<string>(displayName)
  const registryRef = useRef<PredicateInfo[] | null>(null)
  useEffect(() => {
    selectedRef.current = selected
  }, [selected])
  useEffect(() => {
    displayNameRef.current = displayName
  }, [displayName])
  useEffect(() => {
    registryRef.current = registry
  }, [registry])

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
  // up backend doesn't flap the UI / disable scanning (GH #14). We poll
  // quickly while the status is still undetermined so a down backend
  // resolves to "Offline" in a few seconds, then back off to 30s.
  const healthFailuresRef = useRef(0)
  const serviceOnlineRef = useRef<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const runCheck = async () => {
      const healthy = await checkHealthWithRetry(healthCheck)
      if (cancelled) return
      healthFailuresRef.current = healthy ? 0 : healthFailuresRef.current + 1
      const decided = decideServiceOnline(
        serviceOnlineRef.current,
        healthy,
        healthFailuresRef.current,
      )
      serviceOnlineRef.current = decided
      setServiceOnline(decided)
      timer = setTimeout(runCheck, decided === null ? 4000 : 30000)
    }
    void runCheck()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  // Pre-fetch the predicate registry so the configure-first request can be
  // resolved the instant a session connects.
  useEffect(() => {
    listPredicates()
      .then((preds) => setRegistry(preds))
      // Leave the registry unset (not []) on a transient prefetch failure so
      // the configure-first send path refetches on demand. Poisoning it to []
      // made `sendConfiguredRequest` skip the refetch and report the bogus
      // "No checks selected" for every session until reload.
      .catch(() => {})
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
    // Drop the finished session's nonce so it can never leak into the
    // NEXT presentation's request before that session's `session_ready`
    // overwrites it (the "nonce mismatch" root cause).
    nonceRef.current = null
    reconnectAttemptRef.current = 0
    wsRef.current?.close()
    wsRef.current = null
  }, [])

  // Focus/visibility/connectivity-driven recovery.
  useEffect(() => {
    if (!RECOVERABLE_STEPS.has(step)) return
    const maybeReconnect = () => {
      const eng = engagementRef.current
      if (!eng) return
      if (!RECOVERABLE_STEPS.has(stepRef.current)) return
      const ws = wsRef.current
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
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

  const handleSendRequest = useCallback(
    async (predicates: PredicateInfo[], params: Map<string, PredicateParamInput>) => {
      const eng = engagementRef.current
      if (!eng?.ws || !wsRef.current) {
        toast.error('Not connected to session')
        transitionStep('idle')
        return
      }
      const dcql = buildDcqlFromPredicates(predicates, params)
      sentDcqlRef.current = dcql
      const sessionId = eng.ws.sessionId ?? sessionIdFromWsUrl(eng.ws.url) ?? ''
      const nonce = nonceRef.current ?? eng.nonce ?? ''
      const request: PresentationRequest = {
        sessionId,
        verifierName: displayNameRef.current || 'Verifier',
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
    [transitionStep],
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
          window.location.origin,
        )
        setResult(verifyResult)
        transitionStep('result')
        recordHistory(verifyResult)
        if (verifyResult.valid) toast.success('Proof verified')
        else
          toast.error('Verification failed', {
            description: friendlyVerifyError(verifyResult.error) || 'The proof is invalid',
          })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Verification request failed'
        const failResult: VerifyResult = { valid: false, error: message }
        setResult(failResult)
        transitionStep('result')
        recordHistory(failResult)
        toast.error('Verification error', { description: message })
      } finally {
        closeWs()
      }
    },
    [closeWs, transitionStep],
  )

  // Resolve the configure-first selection and send it. Fetches the
  // registry on the fly if the prefetch hasn't landed yet.
  const sendConfiguredRequest = useCallback(async () => {
    if (requestSentRef.current) return
    let reg = registryRef.current
    // Refetch when the registry is unset OR empty — an empty array means the
    // prefetch never resolved (or the backend returned nothing), and reusing
    // it would drop every selected predicate and misreport "No checks selected".
    if (!reg || reg.length === 0) {
      try {
        reg = await listPredicates()
        registryRef.current = reg
        setRegistry(reg)
      } catch {
        goToError('Could not load the verification checks. Try again.')
        return
      }
    }
    const { predicates, params } = buildSelectedRequest(reg, selectedRef.current)
    if (predicates.length === 0) {
      // Distinguish a genuinely empty selection (the Continue button guards
      // against this, so it should be unreachable) from a registry that
      // couldn't resolve the selected checks (stale/empty backend registry).
      goToError(
        selectedRef.current.length === 0
          ? 'No checks selected — go back and pick at least one.'
          : 'Verification checks are unavailable right now. Try again.',
      )
      return
    }
    void handleSendRequest(predicates, params)
  }, [goToError, handleSendRequest])

  const handleWsMessage = useCallback(
    (msg: WsMessage, eng: SessionEngagement) => {
      switch (msg.type) {
        case 'session_ready': {
          const ready = (msg.payload as { nonce?: string } | null) ?? {}
          if (typeof ready.nonce === 'string' && ready.nonce.length > 0) {
            nonceRef.current = ready.nonce
          }
          // Configure-first: auto-send the pre-built request.
          if (!requestSentRef.current) void sendConfiguredRequest()
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
          const nonce = nonceRef.current ?? eng.nonce ?? ''
          handleVerifyPresentation(vpToken, nonce)
          break
        }
        case 'consent_denied': {
          setOutcome('denied')
          setResult(null)
          transitionStep('result')
          recordHistory({ valid: false, error: 'Holder declined the request.' })
          closeWs()
          break
        }
        case 'proof_failed': {
          const reason = 'Holder could not generate a valid proof.'
          setOutcome(null)
          setResult({ valid: false, error: reason })
          transitionStep('result')
          recordHistory({ valid: false, error: reason })
          toast.error('Verification failed', { description: reason })
          closeWs()
          break
        }
        case 'peer_disconnected': {
          if (RECOVERABLE_STEPS.has(stepRef.current)) {
            setStatusMessage('Holder disconnected — waiting for them to reconnect…')
          }
          break
        }
        case 'error': {
          const wsErr = msg.payload as WsError
          goToError(wsErr?.message || 'Session error.')
          break
        }
        default:
          break
      }
    },
    [closeWs, goToError, handleVerifyPresentation, sendConfiguredRequest, transitionStep],
  )

  const connectToSession = useCallback(
    (eng: SessionEngagement) => {
      if (!eng.ws) {
        toast.error('No WebSocket transport in engagement')
        transitionStep('idle')
        return
      }
      const existing = wsRef.current
      if (
        existing &&
        (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
      ) {
        return
      }
      engagementRef.current = eng
      setEngagement(eng)
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
        // Do NOT send the request here. The per-session nonce is carried
        // in the `session_ready` message, which the server only emits once
        // BOTH peers are connected — always AFTER this onopen. Sending on
        // open binds the holder's KB-JWT to a stale/empty nonce (the
        // previous session's `nonceRef`), and verification then fails with
        // "KB-JWT nonce mismatch". `session_ready` (handleWsMessage) sets
        // the fresh nonce and fires the guarded send.
        if (requestSentRef.current && stepRef.current !== 'verifying') {
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
        console.error('[Verifier] WebSocket error')
      }
      ws.onclose = (event) => {
        if (event.code === 1000) return
        if (!RECOVERABLE_STEPS.has(stepRef.current)) return
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
    [goToError, handleWsMessage, transitionStep],
  )

  useEffect(() => {
    connectToSessionRef.current = connectToSession
  }, [connectToSession])

  const handleQrScan = useCallback(
    (data: string) => {
      if (isPresentationEngagement(data)) {
        const eng = decodeSessionEngagement(data)
        if (!eng) {
          toast.error('Invalid engagement QR code')
          return
        }
        connectToSession(eng)
      } else if (isSdJwtVc(data)) {
        toast.info('That QR is a raw credential, not a session code', {
          description:
            'Ask the holder to tap Present in their wallet and show the session QR instead.',
        })
      } else {
        toast.error('Unrecognized QR code', {
          description: 'Expected an Owl ID presentation or SD-JWT VC.',
        })
      }
    },
    [connectToSession],
  )

  const toggleCheck = useCallback((id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }, [])

  const resetSession = useCallback(() => {
    setResult(null)
    setOutcome(null)
    setEngagement(null)
    setStatusMessage('')
    setErrorMessage('')
    sentDcqlRef.current = null
    closeWs()
  }, [closeWs])

  const backToHome = useCallback(() => {
    resetSession()
    transitionStep('idle')
  }, [resetSession, transitionStep])

  const verifyAnother = useCallback(() => {
    resetSession()
    transitionStep('scanning')
  }, [resetSession, transitionStep])

  return (
    <div className="app">
      <TopNav view={view} setView={setView} serviceOnline={serviceOnline} />

      <main className="stage">
        <div className="stage-inner">
          {view === 'verify' && (
            <VerifyView
              step={step}
              result={result}
              outcome={outcome}
              statusMessage={statusMessage}
              errorMessage={errorMessage}
              displayName={displayName}
              setDisplayName={setDisplayName}
              selected={selected}
              toggleCheck={toggleCheck}
              setSelected={setSelected}
              activePreset={activePreset}
              setActivePreset={setActivePreset}
              onContinue={() => {
                if (serviceOnline === false) {
                  toast.error('Verification service is offline', {
                    description: 'Reconnect to verify credentials.',
                  })
                  return
                }
                transitionStep('scanning')
              }}
              onScan={handleQrScan}
              onBackToHome={backToHome}
              onCancel={backToHome}
              onAgain={verifyAnother}
              onDone={backToHome}
            />
          )}

          {view === 'history' && <HistoryScreen onBack={() => setView('verify')} />}

          {view === 'settings' && (
            <SettingsScreen
              displayName={displayName}
              setDisplayName={setDisplayName}
              handle={handle}
              setHandle={setHandle}
              settings={settings}
              setSettings={setSettings}
              onResetPrefs={() => setSettings(DEFAULT_SETTINGS)}
              onBack={() => setView('verify')}
            />
          )}

          {view === 'issuers' && (
            <SimpleView
              title="Trusted issuers"
              eyebrow="Trust anchors"
              onBack={() => setView('verify')}
            >
              <TrustedIssuersList />
            </SimpleView>
          )}

          {view === 'revocations' && (
            <SimpleView
              title="Revocations"
              eyebrow="Credential status"
              onBack={() => setView('verify')}
            >
              <div className="flex flex-col gap-4">
                <RevocationLookup />
                <RevocationsList />
              </div>
            </SimpleView>
          )}
        </div>
      </main>

      <footer className="flex items-center justify-center gap-4 border-t border-[var(--line-1)] px-[clamp(16px,4vw,40px)] py-3.5">
        <p className="m-0 font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--text-3)]">
          Owl ID · Private identity checks
        </p>
        <span className="text-[var(--text-3)] opacity-50">·</span>
        <div className="text-[11px] text-[var(--text-3)]">
          <FaqDialog />
        </div>
      </footer>
    </div>
  )
}

// ============================================
// Top nav
// ============================================
const NAV_LINKS: { id: NavView; label: string; icon: ReactNode }[] = [
  { id: 'verify', label: 'Verify', icon: <IconShield /> },
  { id: 'history', label: 'History', icon: <IconHistory /> },
  { id: 'settings', label: 'Settings', icon: <IconSettings /> },
  { id: 'issuers', label: 'Issuers', icon: <IconScan /> },
  { id: 'revocations', label: 'Revocations', icon: <IconShieldAlert /> },
]

function TopNav({
  view,
  setView,
  serviceOnline,
}: {
  view: NavView
  setView: (v: NavView) => void
  serviceOnline: boolean | null
}) {
  const status =
    serviceOnline === true ? 'online' : serviceOnline === false ? 'offline' : 'checking'
  const statusLabel =
    status === 'online' ? 'Online' : status === 'offline' ? 'Offline' : 'Checking…'
  return (
    <header className="nav">
      <button
        className="nav-brand bg-transparent border-0 p-0 cursor-pointer"
        onClick={() => setView('verify')}
      >
        <OwlMark size={30} />
        <div className="wordmark">
          <span className="name">Owl ID</span>
          <span className="sub">Verifier</span>
        </div>
      </button>

      <div className="nav-spacer" />

      <nav className="nav-links">
        {NAV_LINKS.map((l) => (
          <button
            key={l.id}
            className={`nav-link ${view === l.id ? 'active' : ''}`}
            onClick={() => setView(l.id)}
          >
            {l.icon} {l.label}
          </button>
        ))}
      </nav>

      <span className={`nav-status ${status}`}>
        <span className="dot"></span>
        <span className="label">{statusLabel}</span>
      </span>

      <button
        type="button"
        className="nav-menu-btn"
        aria-label="Switch section"
        onClick={() => {
          const order = NAV_LINKS.map((l) => l.id)
          const next = order[(order.indexOf(view) + 1) % order.length]
          setView(next)
        }}
      >
        <IconMenu />
      </button>
    </header>
  )
}

// ============================================
// Verify view — drives the configure-first flow from the step machine
// ============================================
interface VerifyViewProps {
  step: Step
  result: VerifyResult | null
  outcome: Outcome
  statusMessage: string
  errorMessage: string
  displayName: string
  setDisplayName: (v: string) => void
  selected: string[]
  toggleCheck: (id: string) => void
  setSelected: (ids: string[]) => void
  activePreset: string | null
  setActivePreset: (id: string | null) => void
  onContinue: () => void
  onScan: (data: string) => void
  onBackToHome: () => void
  onCancel: () => void
  onAgain: () => void
  onDone: () => void
}

function VerifyView(p: VerifyViewProps) {
  const { step, result, outcome } = p

  if (step === 'scanning') {
    return (
      <ScanScreen
        displayName={p.displayName}
        selected={p.selected}
        onScan={p.onScan}
        onBack={p.onBackToHome}
      />
    )
  }

  if (step === 'connecting' || step === 'selecting' || step === 'waiting' || step === 'verifying') {
    return <WaitingScreen statusMessage={p.statusMessage} onCancel={p.onCancel} />
  }

  if (step === 'result') {
    if (outcome === 'denied') return <DeniedScreen onAgain={p.onAgain} onDone={p.onDone} />
    if (result?.valid)
      return (
        <VerifiedScreen
          displayName={p.displayName}
          selected={p.selected}
          result={result}
          onAgain={p.onAgain}
          onDone={p.onDone}
        />
      )
    return (
      <FailedScreen
        message={friendlyVerifyError(result?.error) ?? 'The proof is invalid.'}
        onAgain={p.onAgain}
        onDone={p.onDone}
      />
    )
  }

  if (step === 'error') {
    return <FailedScreen message={p.errorMessage} onAgain={p.onAgain} onDone={p.onDone} />
  }

  // idle → the configure-first home screen
  return (
    <HomeScreen
      displayName={p.displayName}
      setDisplayName={p.setDisplayName}
      selected={p.selected}
      toggleCheck={p.toggleCheck}
      setSelected={p.setSelected}
      activePreset={p.activePreset}
      setActivePreset={p.setActivePreset}
      onContinue={p.onContinue}
    />
  )
}

// ============================================
// Simple wrapper for the reused Issuers / Revocations panels
// ============================================
function SimpleView({
  title,
  eyebrow,
  onBack,
  children,
}: {
  title: string
  eyebrow: string
  onBack: () => void
  children: ReactNode
}) {
  return (
    <div className="reveal w-full mx-auto max-w-[880px]">
      <div className="section-head">
        <div className="left">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h1 className="heading-1">{title}</h1>
        </div>
        <div className="right">
          <button className="btn btn-ghost btn-sm" onClick={onBack}>
            Back
          </button>
        </div>
      </div>
      {children}
    </div>
  )
}
