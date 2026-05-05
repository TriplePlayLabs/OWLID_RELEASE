/**
 * OwlVerifier — ergonomic verifier-side client.
 *
 * Customer-facing API for any service that needs to confirm OwlID tokens.
 * Hides the underlying HTTP details and generated runtime so callers work
 * with plain function calls and typed results.
 *
 *     import { OwlVerifier } from '@owlid/sdk'
 *
 *     const verifier = new OwlVerifier({ apiKey: process.env.OWLID_API_KEY })
 *
 *     const challenge = await verifier.mintChallenge()
 *     const result    = await verifier.verify(token, challenge.challenge)
 *     if (result.valid) console.log(result.subjects)
 */
import {
  Configuration,
  IssuersApi,
  PresentationApi,
  RegistryApi,
  RevocationsApi,
  VerificationApi,
} from '@owlid/verifier-client'
import { apiKeyHeaders, resolveWsUrl } from './config.js'

const DEFAULT_BASE_URL = 'https://api.owlid.dev'

export interface OwlVerifierOptions {
  /** Owl API key issued from your account dashboard. Required. */
  apiKey: string
  /** Override the base URL. Defaults to the hosted OwlID platform. */
  baseUrl?: string
}

/** Result of a token verification. */
export interface VerificationResult {
  valid: boolean
  /** Disclosed attributes the holder revealed in the token. Only present if `valid`. */
  subjects?: Record<string, unknown>
  /** Failure reason: untrusted issuer, expired, revoked, challenge mismatch, etc. */
  error?: string
}

/** Single-use challenge minted by Owl. */
export interface Challenge {
  challenge: string
  expiresIn: number
}

/** Trusted issuer entry visible to your account. */
export interface IssuerInfo {
  publicKey: string
  name: string
  description?: string
  isActive: boolean
}

/** Notification pushed when a credential's revocation status changes. */
export interface RevocationEvent {
  credentialId: string
  status: 'revoked' | 'suspended' | 'reactivated'
  reason?: string
}

/**
 * A predicate the system can prove. `op` + `value` are the wire shape the
 * holder puts on a `PredicateRequest` — `value` is JSON-encoded.
 */
export interface Predicate {
  /** Canonical id, e.g. `age:>=18` or `nationality:eu`. */
  id: string
  /** Credential attribute this predicate reads from. */
  attribute: string
  /** Human-readable label. */
  label: string
  /** Operator. */
  op: 'GreaterOrEqual' | 'InSet'
  /**
   * JSON-encoded wire value. For `GreaterOrEqual`, a number (e.g. `'18'`).
   * For `InSet`, a registered dataset name (e.g. `'"eu"'`).
   */
  value: string
}

/** Summary entry for a registered set-membership circuit dataset. */
export interface CircuitDatasetSummary {
  name: string
  version: number
}

/** Full contents of a set-membership circuit dataset. */
export interface CircuitDatasetContents {
  name: string
  version: number
  items: string[]
}

/** Active presentation session (verifier side of the QR flow). */
export interface PresentationSession {
  /** Opaque session id. */
  sessionId: string
  /** WebSocket path the holder QR encodes. */
  wsUrl: string
  /** Single-use nonce bound into the holder's token. */
  nonce: string
  /** Seconds until this session expires. */
  expiresIn: number
  /** Fully resolved WebSocket URL for the verifier role. */
  verifierWsUrl: string
  /** Payload to encode into the QR shown to the holder. */
  qrPayload: string
}

export class OwlVerifier {
  readonly #verification: VerificationApi
  readonly #presentation: PresentationApi
  readonly #issuers: IssuersApi
  readonly #revocations: RevocationsApi
  readonly #registry: RegistryApi
  readonly #baseUrl: string

  constructor(options: OwlVerifierOptions) {
    if (!options?.apiKey) {
      throw new Error('OwlVerifier requires an apiKey. Get one from your Owl dashboard.')
    }
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    const config = new Configuration({
      basePath: this.#baseUrl,
      headers: apiKeyHeaders(options.apiKey),
    })
    this.#verification = new VerificationApi(config)
    this.#presentation = new PresentationApi(config)
    this.#issuers = new IssuersApi(config)
    this.#revocations = new RevocationsApi(config)
    this.#registry = new RegistryApi(config)
  }

  /**
   * Confirm a token against a challenge.
   *
   * `challenge` must match the value the holder bound into the token. Either
   * mint a server-managed challenge with `mintChallenge()` or pass your own
   * cryptographically random string.
   */
  async verify(token: string, challenge: string): Promise<VerificationResult> {
    const r = await this.#verification.verifyToken({ verifyRequest: { token, challenge } })
    return {
      valid: r.valid,
      subjects: r.subjects ?? undefined,
      error: r.error ?? undefined,
    }
  }

  /**
   * Mint a single-use server-managed challenge.
   *
   * Owl tracks the challenge and consumes it atomically on the matching
   * `verify()` call — replays fail. If you don't need replay protection from
   * the platform you can also pass your own random string to `verify()`.
   */
  async mintChallenge(): Promise<Challenge> {
    const r = await this.#verification.generateChallenge()
    return { challenge: r.challenge, expiresIn: r.expiresIn }
  }

  /**
   * Open a QR-based presentation session.
   *
   * Render the returned `qrPayload` for the holder, then connect to
   * `verifierWsUrl`. The holder app pushes a token over the WebSocket; the
   * server consumes the session `nonce` atomically when you call `verify()`.
   */
  async openPresentation(): Promise<PresentationSession> {
    const r = await this.#presentation.createSession()
    const verifierWsUrl = `${resolveWsUrl(r.wsUrl, this.#baseUrl)}?role=verifier`
    const qrPayload = encodeQrPayload({
      sessionId: r.sessionId,
      wsUrl: r.wsUrl,
      nonce: r.nonce,
    })
    return {
      sessionId: r.sessionId,
      wsUrl: r.wsUrl,
      nonce: r.nonce,
      expiresIn: r.expiresIn,
      verifierWsUrl,
      qrPayload,
    }
  }

  /** List trusted issuers visible to your account. */
  async listIssuers(): Promise<IssuerInfo[]> {
    const list = await this.#issuers.listTrustedIssuers()
    return list.map((i) => ({
      publicKey: i.publicKey,
      name: i.name,
      description: i.description ?? undefined,
      isActive: i.isActive,
    }))
  }

  /**
   * List every predicate the system can prove. Each entry carries the
   * canonical id (e.g. `nationality:eu`), the credential attribute it reads
   * from, a human label, and the JSON-encoded `op` + `value` to drop onto a
   * `PredicateRequest`. Apps SHOULD render their proof selector / consent
   * UI from this list rather than hard-coding ids.
   */
  async listPredicates(): Promise<Predicate[]> {
    const list = await this.#registry.listPredicates()
    return list.map((p) => ({
      id: p.id,
      attribute: p.attribute,
      label: p.label,
      op: p.op as Predicate['op'],
      value: p.value,
    }))
  }

  /**
   * List every set-membership dataset the circuits know about (name +
   * version only). Used by `nationality:eu` and any future `InSet` predicate.
   */
  async listCircuitDatasets(): Promise<CircuitDatasetSummary[]> {
    const list = await this.#registry.listCircuitData()
    return list.map((d) => ({ name: d.name, version: d.version }))
  }

  /**
   * Fetch a single dataset's contents. The leaves are what the verifier
   * Merkle-roots when pinning an `InSet` proof — useful for displaying the
   * full set on a consent screen.
   */
  async getCircuitDataset(name: string): Promise<CircuitDatasetContents> {
    const d = await this.#registry.getCircuitDataset({ name })
    return { name: d.name, version: d.version, items: d.items }
  }

  /**
   * Subscribe to revocation events so you can invalidate cached verification
   * results immediately. Returns a function that closes the WebSocket.
   *
   * Browser-only. In Node use `node:ws` and connect to `revocationFeedUrl()`.
   */
  subscribeRevocations(handler: (event: RevocationEvent) => void): () => void {
    if (typeof WebSocket === 'undefined') {
      throw new Error(
        'subscribeRevocations needs a global WebSocket. Use revocationFeedUrl() with your own ws client in Node.',
      )
    }
    const ws = new WebSocket(this.revocationFeedUrl())
    ws.onmessage = (e) => {
      try {
        handler(JSON.parse(typeof e.data === 'string' ? e.data : '') as RevocationEvent)
      } catch {
        // Malformed frames are ignored; the platform never sends non-JSON.
      }
    }
    return () => ws.close()
  }

  /** Raw WebSocket URL for the live revocation feed. */
  revocationFeedUrl(): string {
    return `${resolveWsUrl('/ws/revocations', this.#baseUrl)}`
  }

  /**
   * Run a full QR presentation flow in a single call.
   *
   * Opens a session, sends the proof request when the holder connects, awaits
   * the holder's response, verifies the token, and returns the result. The
   * `onQr` callback receives the QR payload to render to the holder.
   *
   *     const result = await verifier.requestPresentation({
   *       verifierName: 'Acme Bar',
   *       predicates:   [{ id: 'isOver18', label: 'Over 18' }],
   *       onQr:         (payload) => showQr(payload),
   *     })
   *     if (result.valid) console.log(result.subjects)
   */
  async requestPresentation(options: PresentationRequestOptions): Promise<VerificationResult> {
    if (typeof WebSocket === 'undefined') {
      throw new Error(
        'requestPresentation needs a global WebSocket. Use openPresentation() and a Node ws client for server flows.',
      )
    }

    const session = await this.openPresentation()
    options.onQr?.(session.qrPayload)

    const timeoutMs = options.timeoutMs ?? 90_000
    const ws = new WebSocket(session.verifierWsUrl)

    const requestPayload = {
      sessionId: session.sessionId,
      verifierName: options.verifierName,
      requestedPredicates: options.predicates ?? [],
      requestedDisclosures: options.disclose ?? [],
      nonce: session.nonce,
      timestamp: Date.now(),
    }

    return new Promise<VerificationResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error(`Presentation timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      const cleanup = () => {
        clearTimeout(timeout)
        try {
          ws.close()
        } catch {
          // ignore
        }
      }

      ws.onopen = () => {
        // Wait for session_ready before sending the request.
      }
      ws.onerror = () => {
        cleanup()
        reject(new Error('Presentation WebSocket error'))
      }
      ws.onclose = () => clearTimeout(timeout)
      ws.onmessage = async (event) => {
        let msg: { type?: string; payload?: unknown }
        try {
          msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
        } catch {
          return
        }

        switch (msg.type) {
          case 'session_ready':
            ws.send(JSON.stringify({ type: 'request', payload: requestPayload }))
            break
          case 'response': {
            const payload = (msg.payload ?? {}) as { compactToken?: string; token?: string }
            const token = payload.compactToken ?? payload.token ?? ''
            cleanup()
            try {
              resolve(await this.verify(token, session.nonce))
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)))
            }
            break
          }
          case 'consent_denied':
            cleanup()
            resolve({ valid: false, error: 'Holder denied consent' })
            break
          case 'error': {
            const payload = (msg.payload ?? {}) as { message?: string }
            cleanup()
            resolve({ valid: false, error: payload.message ?? 'Presentation error' })
            break
          }
        }
      }
    })
  }
}

/** Options for {@link OwlVerifier.requestPresentation}. */
export interface PresentationRequestOptions {
  /** Display name shown on the holder's consent screen. */
  verifierName: string
  /** ZK predicates the holder must prove. */
  predicates?: Array<{ id: string; label: string }>
  /** Attribute names to disclose in plaintext. */
  disclose?: string[]
  /** Callback to render the QR payload for the holder. */
  onQr?: (qrPayload: string) => void
  /** Abort after this many milliseconds. Defaults to 90 s. */
  timeoutMs?: number
}

// Backwards-compatibility re-export of the generated verifier-client. Internal
// apps that hand-build hooks against the raw generated surface keep working;
// new public-facing apps should prefer `OwlVerifier` above.
export * from '@owlid/verifier-client'

function encodeQrPayload(engagement: { sessionId: string; wsUrl: string; nonce: string }): string {
  // QR payload is the JSON-serialised engagement, base64url-encoded for
  // robust transport across QR libraries that don't tolerate `=` padding.
  const json = JSON.stringify(engagement)
  if (typeof btoa === 'function') {
    return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  // Node fallback.
  return Buffer.from(json, 'utf8').toString('base64url')
}
