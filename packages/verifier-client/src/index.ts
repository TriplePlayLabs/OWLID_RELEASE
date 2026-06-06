/**
 * @owlid/verifier-client
 *
 * Customer-facing API client for the OwlID **Verification Service**. Use this
 * package in any app that needs to verify tokens, run the verifier-side
 * presentation protocol (QR scan → WebSocket → token), check public
 * revocation status, or list trusted issuers.
 *
 * Configure once at app startup via `configure()` from `@owlid/config`:
 *
 *     import { configure } from '@owlid/config'
 *     import { getVerificationApi } from '@owlid/verifier-client'
 *
 *     configure({ verificationUrl: 'https://api.example.com', apiKey })
 *
 *     const result = await getVerificationApi().verifyToken({
 *       verifyRequest: { token, challenge },
 *     })
 *
 * Operator-only endpoints (admin auth, GDPR erasure, manage-issuers,
 * manage-revocations, detailed metrics) live in `@owlid/admin-client`.
 */

import { Configuration } from './runtime.js'
import { apiKeyHeaders, getApiKey, getVerificationUrl } from '@owlid/config'
import {
  IssuersApi,
  MonitoringApi,
  PredicatesApi,
  PresentationApi,
  RegistryApi,
  RevocationsApi,
  VerificationApi,
} from './apis/index.js'

export interface VerifierClientOptions {
  basePath?: string
  apiKey?: string
  headers?: Record<string, string>
}

function buildConfig(opts?: VerifierClientOptions): Configuration {
  const apiKey = opts?.apiKey ?? getApiKey()
  return new Configuration({
    basePath: getVerificationUrl(opts?.basePath),
    // Caller's per-call headers override the API-key baseline (e.g. a
    // per-session `Authorization: Bearer <session_token>` on protected
    // routes).
    headers: { ...apiKeyHeaders(apiKey), ...opts?.headers },
    // Send the admin session cookie (`owlid_admin_token`) when the SPA is
    // logged in. The verification service accepts either an API key
    // (Authorization header) or an admin session cookie. Setting
    // `credentials: 'include'` is required for the cookie to cross
    // origins in fetch; the backend's CORS layer already has
    // `allow_credentials(true)` with an explicit origin allowlist.
    credentials: 'include',
  })
}

let _verificationApi: VerificationApi | null = null
let _presentationApi: PresentationApi | null = null
let _issuersApi: IssuersApi | null = null
let _monitoringApi: MonitoringApi | null = null
let _revocationsApi: RevocationsApi | null = null
let _registryApi: RegistryApi | null = null
let _predicatesApi: PredicatesApi | null = null
let _cachedConfig: Configuration | null = null

function sharedConfig(opts?: VerifierClientOptions): Configuration {
  if (_cachedConfig && !opts) return _cachedConfig
  const cfg = buildConfig(opts)
  if (!opts) _cachedConfig = cfg
  return cfg
}

/** Token verification: verifyToken, generateChallenge. */
export function getVerificationApi(opts?: VerifierClientOptions): VerificationApi {
  if (_verificationApi && !opts) return _verificationApi
  const api = new VerificationApi(sharedConfig(opts))
  if (!opts) _verificationApi = api
  return api
}

/** Presentation sessions for the QR flow: createPresentationSession. */
export function getPresentationApi(opts?: VerifierClientOptions): PresentationApi {
  if (_presentationApi && !opts) return _presentationApi
  const api = new PresentationApi(sharedConfig(opts))
  if (!opts) _presentationApi = api
  return api
}

/** Trusted-issuer directory (read-only): listTrustedIssuers. */
export function getIssuersApi(opts?: VerifierClientOptions): IssuersApi {
  if (_issuersApi && !opts) return _issuersApi
  const api = new IssuersApi(sharedConfig(opts))
  if (!opts) _issuersApi = api
  return api
}

/** Public health probe. */
export function getMonitoringApi(opts?: VerifierClientOptions): MonitoringApi {
  if (_monitoringApi && !opts) return _monitoringApi
  const api = new MonitoringApi(sharedConfig(opts))
  if (!opts) _monitoringApi = api
  return api
}

/** Revocation lookups (read-only): checkRevocation, listRevoked. */
export function getRevocationsApi(opts?: VerifierClientOptions): RevocationsApi {
  if (_revocationsApi && !opts) return _revocationsApi
  const api = new RevocationsApi(sharedConfig(opts))
  if (!opts) _revocationsApi = api
  return api
}

/**
 * Predicate + circuit-dataset registry (public reference data, no auth):
 * listPredicates, listCircuitData, getCircuitDataset.
 */
export function getRegistryApi(opts?: VerifierClientOptions): RegistryApi {
  if (_registryApi && !opts) return _registryApi
  const api = new RegistryApi(sharedConfig(opts))
  if (!opts) _registryApi = api
  return api
}

export function getPredicatesApi(opts?: VerifierClientOptions): PredicatesApi {
  if (_predicatesApi && !opts) return _predicatesApi
  const api = new PredicatesApi(sharedConfig(opts))
  if (!opts) _predicatesApi = api
  return api
}

/** One status event pushed over the `/predicates/tx/:txId/events`
 *  SSE stream. Mirrors the wire shape the sidecar emits. */
export interface PredicateStatusEvent {
  txId: string
  status: string
  error?: string
}

/**
 * Subscribe to the SSE stream of relay-job phase transitions for a
 * specific `txId` (or relay job-id). The system uses exactly two
 * notification transports end-to-end: WS for two-way channels and
 * SSE for server→client pushes. This is the SSE side; there is no
 * polling fallback by design.
 *
 * Uses `fetch` + `ReadableStream` rather than the browser's
 * `EventSource` so the `Authorization: Bearer …` header set by
 * `@owlid/config` reaches the verification service. (`EventSource`
 * does not allow custom headers.)
 *
 * Auto-reconnects on transport-level disconnects (Cloud Run idle
 * teardown, browser network change, edge-proxy connection drop)
 * with exponential back-off up to ~30 s. Reconnect is safe: the
 * sidecar always emits the current job snapshot as its first event,
 * so a late re-subscriber catches up to the latest known state
 * without missing the terminal status. Stops reconnecting on a
 * terminal status, on `AbortSignal`, or on a non-retryable HTTP
 * status (4xx other than 408/429).
 *
 * Yields one event per phase transition the sidecar pushes; completes
 * when the sidecar emits a terminal status and closes the stream.
 */
export async function* streamPredicateStatus(
  jobId: string,
  opts?: VerifierClientOptions & { signal?: AbortSignal },
): AsyncGenerator<PredicateStatusEvent> {
  const apiKey = opts?.apiKey ?? getApiKey()
  const basePath = getVerificationUrl(opts?.basePath)
  const url = `${basePath}/predicates/job/${encodeURIComponent(jobId)}/events`
  const TERMINAL = new Set([
    'SucceedEntirely',
    'FailEntirely',
    'FailFallible',
    'balance-failed',
    'submit-failed',
    // `unknown` means the server couldn't reach a determinate state
    // (e.g. job-id wasn't in the in-memory map AND the chain didn't
    // observe the tx). Treat as terminal so a misrouted id can't
    // spin a reconnect loop forever — without this guard a sidecar
    // restart that lost the in-memory `relayJobs` table produced
    // ~30 reconnects per second from every active holder.
    'unknown',
  ])
  // Back-off schedule used after every transport-level disconnect.
  // Caps at ~30 s so a sustained outage doesn't burn the client; the
  // outer caller can supply its own abort signal for a hard cap.
  const backoff = [1000, 2000, 4000, 8000, 16000, 30000]
  // Hard cap on reconnects per call. Defence against any server-side
  // bug that closes the stream without a terminal status — the
  // signal/abort path is still the primary way to stop early, but
  // this prevents a runaway loop if the abort signal is missing.
  const MAX_RECONNECTS = 30
  let attempt = 0
  let seenTerminal = false
  while (!seenTerminal) {
    if (attempt >= MAX_RECONNECTS) {
      throw new Error(
        `predicate status stream gave up after ${MAX_RECONNECTS} reconnects without a terminal status`,
      )
    }
    if (opts?.signal?.aborted) return
    let res: Response
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          ...apiKeyHeaders(apiKey),
          ...opts?.headers,
        },
        credentials: 'include',
        signal: opts?.signal,
        // Hint to the runtime to keep the connection alive long-term.
        // Browsers ignore unknown init keys; Node 20+ honours `keepalive`
        // for short requests only — neither hurts here.
        keepalive: false,
      })
    } catch (e) {
      if (opts?.signal?.aborted) return
      // Network-level failure (DNS, offline, TCP RST). Retry with backoff.
      await sleep(backoff[Math.min(attempt, backoff.length - 1)])
      attempt++
      continue
    }
    if (!res.ok || !res.body) {
      // 4xx non-retryable; 5xx retryable.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        throw new Error(`predicate status stream failed: ${res.status} ${res.statusText}`)
      }
      await sleep(backoff[Math.min(attempt, backoff.length - 1)])
      attempt++
      continue
    }
    // NOTE: do NOT reset `attempt` merely on a 200. A degraded sidecar
    // (mid-resync: `getClient()` throws) returns 200 then immediately emits
    // an `error` frame and closes — if that reset the counter, the cap below
    // would never bite and the client would reconnect ~1/s forever (the
    // observed 375-request storm). Reset only on REAL progress (a yielded
    // status event), so empty/error closes accumulate toward MAX_RECONNECTS.
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const frame = parseSseFrame(raw)
          if (frame.event === 'status' && frame.data) {
            try {
              const ev = JSON.parse(frame.data) as PredicateStatusEvent
              yield ev
              attempt = 0 // real progress — reset the reconnect budget
              if (TERMINAL.has(ev.status)) seenTerminal = true
            } catch {
              /* ignore malformed frame */
            }
          }
          // `ping` keep-alives + unknown event names are ignored.
          if (frame.event === 'error') {
            // A server-side error frame means the sidecar hit an error
            // (e.g. MidnightClient not connected during resync). Surface it
            // to the caller and STOP — reconnecting against a persistently
            // degraded sidecar just storms. The caller (orchestrator) treats
            // a thrown status stream as a failed predicate and moves on.
            throw new Error(frame.data || 'sidecar emitted error')
          }
        }
      }
    } catch (e) {
      if (opts?.signal?.aborted) return
      // A server `error` frame (vs a transport drop) is terminal — don't
      // reconnect into a degraded sidecar. Transport drops mid-stream fall
      // through to the capped backoff-reconnect below.
      if (e instanceof Error && /sidecar emitted error/.test(e.message)) throw e
      // Transport-level drop (Cloud Run teardown, ERR_NETWORK_CHANGED):
      // loop reconnects from the top, under the MAX_RECONNECTS cap.
    } finally {
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
    }
    if (seenTerminal) return
    // EOF without terminal status — reconnect, BUT with backoff to
    // avoid hammering when the server keeps returning fast
    // non-terminal responses (e.g. job-not-found edge case the
    // server should have collapsed itself but might miss for new
    // failure modes).
    await sleep(backoff[Math.min(attempt, backoff.length - 1)])
    attempt++
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseSseFrame(raw: string): { event?: string; data?: string; id?: string } {
  let event: string | undefined
  let id: string | undefined
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue
    const sep = line.indexOf(':')
    const field = sep < 0 ? line : line.slice(0, sep)
    const value = sep < 0 ? '' : line.slice(sep + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
    else if (field === 'id') id = value
  }
  return { event, id, data: dataLines.length ? dataLines.join('\n') : undefined }
}

/** Drop cached singletons (useful in tests after reconfiguring). */
export function resetVerifierClient(): void {
  _verificationApi = null
  _presentationApi = null
  _issuersApi = null
  _monitoringApi = null
  _revocationsApi = null
  _registryApi = null
  _predicatesApi = null
  _cachedConfig = null
}

export {
  Configuration,
  IssuersApi,
  MonitoringApi,
  PredicatesApi,
  PresentationApi,
  RegistryApi,
  RevocationsApi,
  VerificationApi,
}

export type {
  VerifyDcqlRequest,
  VerifyDcqlResponse,
  VerifyResponse,
  DcqlRequest,
  DcqlCredentialQuery,
  DcqlMeta,
  DcqlClaimQuery,
  DcqlCredentialSet,
  ChallengeResponse,
  CheckRevocationRequest,
  CheckRevocationResponse,
  CreatePresentationResponse,
  TrustedIssuerInfo,
  PredicateInfo,
  CircuitDataset,
  CircuitDatasetInfo,
  RevocationEntry,
  CheckPredicateRequest,
  CheckPredicateResponse,
  PredicateSnapshotResponse,
  RelayProofRequest,
  RelayProofResponse,
  OwlPredicate,
} from './models/index.js'
