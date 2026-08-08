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
 *
 * Module layout:
 *   - `index.ts`              `OwlVerifier` class
 *   - `types.ts`              option/result type surface
 *   - `qr.ts`                 holder QR engagement encoder
 *   - `presentation-flow.ts`  WS-driven request/response dance
 */
import {
  Configuration,
  IssuersApi,
  PresentationApi,
  RegistryApi,
  RevocationsApi,
  VerificationApi,
  type DcqlRequest,
  type VerifyDcqlResponse,
} from '@owlid/verifier-client'
import { apiKeyHeaders, resolveWsUrl } from '@owlid/config'

import { encodeQrPayload } from './qr.js'
import { runPresentationFlow } from './presentation-flow.js'
import { buildDcqlRequest, type PredicateRequest } from '../predicates.js'
import {
  ageKey,
  ageRangeKey,
  allowedCountrySetHash,
  emailVerifiedKey,
  keyHex,
  kycKey,
  nationalityKey,
  residencyKey,
  uniquePersonhoodKey,
} from '../midnight/attestation-keys.js'
import { hexToBytes } from '../encoding.js'
import type {
  Challenge,
  CircuitDatasetContents,
  CircuitDatasetSummary,
  IssuerInfo,
  OwlVerifierOptions,
  Predicate,
  PresentationRequestOptions,
  PresentationSession,
  RevocationEvent,
  VerificationResult,
} from './types.js'

const DEFAULT_BASE_URL = 'https://api.owlid.app'

export class OwlVerifier {
  readonly #verification: VerificationApi
  readonly #presentation: PresentationApi
  readonly #issuers: IssuersApi
  readonly #revocations: RevocationsApi
  readonly #registry: RegistryApi
  readonly #baseUrl: string
  readonly #apiKey: string

  constructor(options: OwlVerifierOptions) {
    if (!options?.apiKey) {
      throw new Error('OwlVerifier requires an apiKey. Get one from your Owl dashboard.')
    }
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.#apiKey = options.apiKey
    const config = new Configuration({
      basePath: this.#baseUrl,
      headers: apiKeyHeaders(this.#apiKey),
    })
    this.#verification = new VerificationApi(config)
    this.#presentation = new PresentationApi(config)
    this.#issuers = new IssuersApi(config)
    this.#revocations = new RevocationsApi(config)
    this.#registry = new RegistryApi(config)
  }

  /**
   * Confirm a single-credential SD-JWT VC presentation against a challenge.
   *
   * Thin wrapper over {@link verifyDcql} that builds a 1-entry DCQL vp_token
   * (`{cred0: presentation}`). Use {@link verifyDcql} directly to verify
   * multi-credential presentations.
   */
  async verify(
    presentation: string,
    challenge: string,
    audience?: string,
    verifierId?: string,
  ): Promise<VerificationResult> {
    const r = await this.verifyDcql(
      // OID4VP 1.0 §8.1 — vp_token values are always arrays, even
      // when the DCQL query did not set `multiple: true`.
      { cred0: [presentation] },
      challenge,
      audience,
      undefined,
      verifierId,
    )
    const per = r.perCredential.cred0
    return {
      valid: r.valid,
      subjects: per?.subjects ?? undefined,
      error: r.error ?? per?.error ?? undefined,
    }
  }

  /**
   * Verify a DCQL `vp_token` (OpenID4VP 1.0 §6 + §8.1).
   *
   * `vpToken` is keyed by DCQL credential id; each value is an SD-JWT VC
   * presentation (`<JWT>~<disc>~…~<KB-JWT>`). Every KB-JWT must be signed
   * over the same `challenge`. When `audience` is set it applies to every
   * entry. `query` defaults to a permissive query that accepts whatever
   * the holder discloses; pass a real DCQL query when the verifier needs
   * `format`/`meta`/`claims`/`credential_sets` constraints enforced.
   */
  async verifyDcql(
    vpToken: Record<string, string[]>,
    challenge: string,
    audience?: string,
    query?: DcqlRequest,
    verifierId?: string,
  ): Promise<VerifyDcqlResponse> {
    return await this.#verification.verifyDcql({
      verifyDcqlRequest: {
        vpToken,
        challenge,
        audience,
        verifierId,
        query: query ?? {
          credentials: Object.keys(vpToken).map((id) => ({
            id,
            format: 'dc+sd-jwt',
            claims: [],
          })),
        },
      },
    })
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
    if (!this.#apiKey.startsWith('owlid_pk_')) {
      throw new Error('OwlVerifier.openPresentation requires an owlid_pk_* publishable key.')
    }
    const r = await this.#presentation.createSession({ createPresentationRequest: {} })
    const verifierWsUrl = `${resolveWsUrl(r.wsUrl, this.#baseUrl)}?role=verifier&apiKey=${encodeURIComponent(this.#apiKey)}`
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
   * Opens a session, sends the DCQL request when the holder connects, awaits
   * the holder's response, verifies the `vp_token` map, returns the merged
   * result. `onQr` renders the engagement QR to the holder.
   *
   *     const result = await verifier.requestPresentation({
   *       verifierName: 'Acme Bar',
   *       dcql: { credentials: [{ id: 'p', format: 'dc+sd-jwt',
   *         claims: [{ path: ['age_over'], values: [18] }] }] },
   *       onQr: (payload) => showQr(payload),
   *     })
   *     if (result.valid) console.log(result.subjects)
   */
  async requestPresentation(options: PresentationRequestOptions): Promise<VerifyDcqlResponse> {
    const session = await this.openPresentation()
    // verifierId binds the per-verifier attestation salt; an undefined one
    // would silently produce a different on-chain key than verifyDcql expects.
    const resolved = { ...options, verifierId: options.verifierId ?? this.verifierId() }
    return runPresentationFlow(session, resolved, (vp, ch, aud, q, vid) =>
      this.verifyDcql(vp, ch, aud, q, vid),
    )
  }

  /**
   * Stable identity this verifier presents to holders as its OID4VP
   * `client_id`. Folded into per-verifier salts so two verifiers
   * asking for the same allowed-set produce distinct on-chain
   * attestation keys. Defaults to the verifier's deployment base URL;
   * override with `OwlVerifierOptions.verifierId` if you need a fixed
   * value across multiple deployments (e.g. behind a load balancer).
   */
  verifierId(): string {
    return this.#baseUrl
  }

  /**
   * Compile a list of declarative {@link PredicateRequest}s into the
   * on-wire DCQL request shape the holder app solves. Exposed so
   * callers who want the raw DCQL (external wallets, request_uri
   * publishing) can build it without hand-rolling JSON; most callers
   * should use {@link requestPredicates} instead.
   */
  buildDcqlRequest(predicates: PredicateRequest[]): DcqlRequest {
    return buildDcqlRequest(predicates)
  }

  /**
   * Ergonomic single-call presentation flow: open a session, send a
   * predicate-driven DCQL request, await the holder's response, verify
   * it, and return the merged result. Replaces hand-rolling DCQL +
   * calling {@link requestPresentation}.
   *
   *     await verifier.requestPredicates({
   *       verifierName: 'Acme Bar',
   *       predicates: [
   *         Predicates.ageOver(18),
   *         Predicates.residencyIn(['NL', 'BE', 'DE']),
   *       ],
   *       onQr: (qr) => render(qr),
   *     })
   */
  async requestPredicates(opts: {
    verifierName: string
    predicates: PredicateRequest[]
    onQr?: (qrPayload: string) => void
    timeoutMs?: number
  }): Promise<VerifyDcqlResponse> {
    return this.requestPresentation({
      verifierName: opts.verifierName,
      verifierId: this.verifierId(),
      dcql: this.buildDcqlRequest(opts.predicates),
      onQr: opts.onQr,
      timeoutMs: opts.timeoutMs,
    })
  }

  /**
   * Off-chain SHA-256 of the verifier's allowed-set commitment for an
   * `nationalityIn` / `residencyIn` policy. Returns a 64-char hex
   * string identical to the `setHash` that lands on chain.
   *
   * Use when building a verifier dashboard that counts attestations
   * under your own policy, or when publishing your allowed-set to an
   * off-chain audit registry. The recipe canonicalises (sort + dedupe
   * + uppercase) before hashing so input order doesn't matter.
   */
  async computeAllowedSetHash(countries: string[]): Promise<string> {
    const bytes = await allowedCountrySetHash(this.verifierId(), countries)
    return keyHex(bytes)
  }

  /**
   * Recompute the on-chain attestation key the verifier would look up
   * for a given (credential, predicate) pair. Returns a 64-char hex
   * string. Useful for verifier dashboards or off-chain audit tools
   * that need the key without round-tripping `/predicates/attested`.
   *
   * `credentialId` is the SD-JWT VC `credential_id` (32-byte hex).
   * Per-verifier salt is automatically folded in for set-membership
   * predicates via {@link verifierId}.
   */
  async attestationKeyFor(credentialId: string, predicate: PredicateRequest): Promise<string> {
    const rootHash = hexToBytes(credentialId)
    if (rootHash.length !== 32) {
      throw new Error(`credentialId must be 32-byte hex; got ${rootHash.length} bytes`)
    }
    let key: Uint8Array
    switch (predicate.kind) {
      case 'ageOver':
        key = await ageKey(rootHash, predicate.threshold)
        break
      case 'ageRange':
        key = await ageRangeKey(rootHash, predicate.min, predicate.max)
        break
      case 'kycLevel': {
        const n =
          typeof predicate.level === 'number'
            ? predicate.level
            : predicate.level === 'high'
              ? 3
              : predicate.level === 'substantial'
                ? 2
                : 1
        key = await kycKey(rootHash, n)
        break
      }
      case 'emailVerified':
        key = await emailVerifiedKey(rootHash)
        break
      case 'uniquePerson':
        key = await uniquePersonhoodKey(
          rootHash,
          predicate.epoch,
          predicate.appId,
          this.verifierId(),
        )
        break
      case 'nationalityIn':
        key = await nationalityKey(rootHash, this.verifierId(), predicate.countries)
        break
      case 'residencyIn':
        key = await residencyKey(rootHash, this.verifierId(), predicate.countries)
        break
    }
    return keyHex(key)
  }
}

export type {
  Challenge,
  CircuitDatasetContents,
  CircuitDatasetSummary,
  IssuerInfo,
  OwlVerifierOptions,
  Predicate,
  PresentationRequestOptions,
  PresentationSession,
  RevocationEvent,
  VerificationResult,
} from './types.js'

// Backwards-compatibility re-export of the generated verifier-client. Internal
// apps that hand-build hooks against the raw generated surface keep working;
// new public-facing apps should prefer `OwlVerifier` above.
export * from '@owlid/verifier-client'
