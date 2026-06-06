/**
 * OwlWallet — multi-credential aggregator + DCQL solver.
 *
 * Solves an OpenID4VP 1.0 §6 DCQL request against the credentials in
 * the local wallet, then builds the §8.1 `vp_token` map by signing one
 * KB-JWT per chosen credential — all bound to the same `aud` + `nonce`.
 * Per-credential `cnf` keys are preserved on the wire so colluding
 * verifiers cannot correlate across separate presentations (Research
 * §1.3 — the "contextual same-person" model).
 */
import type { DcqlCredentialQuery, DcqlCredentialSet, DcqlRequest } from '@owlid/verifier-client'
import { CredentialStorageManager, type WalletCredential } from './storage.js'
import { presentSdJwtVc } from './present.js'
import { SdJwtVc } from './sd-jwt.js'
import { toAlpha2 } from './countries.js'
import { readOwlPredicate, type OwlPredicate } from './owl-dcql.js'
import {
  attestationCovers,
  routeClaim,
  createPredicateAssets,
  createPredicateTransport,
  ensureCredentialPredicatesAttested,
  type AttestProgress,
  type EnsureResult,
  type OwlAttestationRef,
  type PredicateAssets,
  type PredicateTransport,
  type ProvingProviderConfig,
} from './midnight/index.js'

/** Caller-supplied PRF unwrap. Called once per chosen credential per
 *  presentation; the resulting hex seed is held in memory only for the
 *  span of `present()` and is dropped before it returns. */
export type OpenHolderKeyFn = (
  passkeyCredentialId: string | null,
  wrappedHolderSeed: string,
) => Promise<string>

/** Audience the self-revocation KB-JWT is bound to. MUST match
 *  `api::SELF_REVOKE_AUDIENCE` in the verification-service — a presentation
 *  built for a verifier (different `aud`) therefore can't be replayed to
 *  revoke the credential. */
export const SELF_REVOKE_AUDIENCE = 'owlid:revocation:self'

export interface WalletPresentRequest {
  dcql: DcqlRequest
  /** KB-JWT `aud` — the verifier's identifier. Shared across credentials. */
  aud: string
  /** KB-JWT `nonce` — the verifier's one-shot nonce. Shared. */
  nonce: string
  /** OID4VP verifier `client_id` (typically the response_uri). Required
   *  when the DCQL contains a `nationality_in` / `resident_in` claim:
   *  folded into the on-chain attestation key as a per-verifier salt so
   *  two verifiers asking the same allowed-set produce distinct keys. */
  verifierId?: string
  /** Override the candidate chosen for a DCQL query id (UI affordance). */
  overrides?: Record<string, string>
  /** Observe the per-credential Midnight attestation step (first-time
   *  proving on device + relay). Drives the consent screen's
   *  "Generating proof for X…" / "Submitting to Midnight…" copy so the
   *  user sees progress instead of a silent ~20-30s pause on first use. */
  onAttestProgress?: (event: AttestProgress) => void
  /** Cancellation signal. Aborting tears down the in-flight SSE
   *  attestation subscription and exits the orchestrator with a
   *  "presentation aborted by caller" error, so the holder UI can
   *  close cleanly without leaving an orphan stream running. */
  signal?: AbortSignal
}

export interface WalletPresentResult {
  /** OID4VP 1.0 §8.1 vp_token shape: always `string[]`, one entry
   *  per matching presentation. With `multiple: false` (the default),
   *  each array has exactly one element. */
  vpToken: Record<string, string[]>
  /** Per DCQL id: which credentialId answered + which disclosures the
   *  holder revealed. Drives the UI receipt + the cross-cred linkage
   *  banner shown in the consent flow. */
  used: Array<{ dcqlId: string; credentialId: string; disclosures: string[] }>
  /** Per credential: the predicate attestations the orchestrator
   *  ensured were on Midnight before signing. Empty when every
   *  predicate was already attested or none routed. */
  attested: EnsureResult[]
}

export interface DcqlMatchEntry {
  dcqlId: string
  /** Every wallet credential that satisfies the query, newest first. */
  candidates: WalletCredential[]
  /** The disclosures that would be revealed if this query is answered. */
  disclosures: string[]
}

export interface DcqlMatchSummary {
  entries: DcqlMatchEntry[]
  /** `true` iff every `credential_sets` constraint can be satisfied by
   *  picking one candidate per credentials[].id. */
  satisfiable: boolean
  /** Human-readable reason when `satisfiable === false`. */
  reason?: string
}

export interface OwlWalletOptions {
  /** Predicate asset factory — defaults to the browser/`@owlid/sdk` wiring
   *  that fetches Compact ZK artifacts over the verification-service
   *  `/predicate-zk` endpoint. Override in tests/Node. */
  predicateAssets?: PredicateAssets
  /** Predicate transport — defaults to the generated `PredicatesApi`
   *  client (auto-configured from `@owlid/config`). Override in tests. */
  predicateTransport?: PredicateTransport
  /** Holder-device proving backend. When omitted the SDK reads
   *  `@owlid/config` (`provingMode` + `proofServerUrl`) at present-time;
   *  default is in-process WASM. Pass an explicit value to bypass global
   *  config (e.g. a UI toggle that hasn't yet flushed to `configure()`). */
  provingConfig?: ProvingProviderConfig
}

export class OwlWallet {
  private readonly predicateAssets: PredicateAssets
  private readonly predicateTransport: PredicateTransport
  private readonly provingConfig?: ProvingProviderConfig

  constructor(
    private readonly storage: CredentialStorageManager,
    private readonly openHolderKey: OpenHolderKeyFn,
    private readonly passkeyResolver: () => Promise<string | null>,
    opts: OwlWalletOptions = {},
  ) {
    // Lazily construct the defaults so unit tests that never call
    // present() don't trigger the @owlid/verifier-client init.
    this.predicateAssets = opts.predicateAssets ?? createPredicateAssets()
    this.predicateTransport = opts.predicateTransport ?? createPredicateTransport()
    this.provingConfig = opts.provingConfig
  }

  /** Inspect the local wallet against a DCQL request without producing
   *  KB-JWTs — feeds the consent UI's "what would be disclosed". */
  async match(query: DcqlRequest): Promise<DcqlMatchSummary> {
    const credentials = await this.storage.listCredentials()
    return matchDcqlAgainst(credentials, query)
  }

  /** Solve `req.dcql`, sign per-credential KB-JWTs bound to the shared
   *  `aud`/`nonce`, return the vp_token map keyed by DCQL credential id. */
  async present(req: WalletPresentRequest): Promise<WalletPresentResult> {
    const credentials = await this.storage.listCredentials()
    const summary = matchDcqlAgainst(credentials, req.dcql)
    if (!summary.satisfiable) {
      throw new Error(summary.reason ?? 'DCQL request unsatisfied by wallet')
    }

    const passkeyId = await this.passkeyResolver()

    const chosen = chooseAcrossSets(summary, req.dcql, req.overrides)

    // OID4VP 1.0 §8.1 mandates the vp_token value is always an
    // array — `multiple: false` produces a 1-element array, not a
    // bare string. We never set `multiple: true`, so every entry
    // here is a single-element array.
    const vpToken: Record<string, string[]> = {}
    const used: WalletPresentResult['used'] = []
    const attested: EnsureResult[] = []

    for (const pick of chosen) {
      // Ensure ONLY the predicates the verifier actually requires are
      // on Midnight for this credential before we KB-sign. The
      // credential may carry extra issuer-stamped attestations (older
      // creds were over-stamped); proving them is wasted work and may
      // even be infeasible (witness < stamped threshold). Filter
      // against the DCQL the verifier sent.
      const credentialJson = walletCredentialToProofJson(pick.credential)
      const dcqlQuery = req.dcql.credentials.find((c) => c.id === pick.dcqlId)
      const required = dcqlQuery ? requiredAttestationsFor(dcqlQuery, req.verifierId) : undefined
      const ensureResults = await ensureCredentialPredicatesAttested(
        credentialJson,
        this.predicateAssets,
        this.predicateTransport,
        req.onAttestProgress,
        required,
        this.provingConfig,
        req.signal,
      )
      attested.push(...ensureResults)

      const wrapped = await this.storage.getCredentialKeyWrapped(pick.credential.credentialId)
      if (!wrapped) {
        throw new Error(`Missing holder key for credential ${pick.credential.credentialId}`)
      }
      // Surface the passkey UV prompt + KB-JWT signing as their own
      // steps so the consent modal's timeline shows them — otherwise
      // the user sees an unexplained passkey dialog mid-flow.
      const credLabel = pick.dcqlId
      req.onAttestProgress?.({ stage: 'unlock', predicate: credLabel })
      const holderKeyHex = await this.openHolderKey(passkeyId, wrapped)
      req.onAttestProgress?.({ stage: 'sign', predicate: credLabel })
      const presentation = presentSdJwtVc(pick.credential.sdJwtVc, holderKeyHex, pick.disclosures, {
        aud: req.aud,
        nonce: req.nonce,
      })
      vpToken[pick.dcqlId] = [presentation]
      used.push({
        dcqlId: pick.dcqlId,
        credentialId: pick.credential.credentialId,
        disclosures: pick.disclosures,
      })
    }

    return { vpToken, used, attested }
  }

  /**
   * Revoke ONE of the holder's own credentials on-chain by proving
   * possession of its `cnf` holder key — no admin key on the device.
   *
   * Fetches a one-shot server challenge, signs a KB-JWT over it bound to
   * {@link SELF_REVOKE_AUDIENCE}, and posts the presentation to
   * `/revocations/revoke-mine`. The server verifies the proof of
   * possession (issuer signature binds `cnf` ↔ credential, KB-JWT proves
   * the holder controls `cnf`) and revokes with the ISSUER key, so a
   * holder can only ever revoke a credential they can prove they hold.
   *
   * Triggers a passkey user-verification prompt (the unlock gesture) —
   * this is a destructive, irreversible action.
   */
  async revoke(
    credentialId: string,
    reason?: string,
  ): Promise<{ revoked: boolean; credentialId: string; alreadyRevoked: boolean }> {
    const credentials = await this.storage.listCredentials()
    const cred = credentials.find((c) => c.credentialId === credentialId)
    if (!cred) throw new Error(`No credential ${credentialId} in this wallet`)

    const wrapped = await this.storage.getCredentialKeyWrapped(credentialId)
    if (!wrapped) throw new Error(`Missing holder key for credential ${credentialId}`)

    // Lazy import keeps the verifier-client init off the cheaper paths.
    const { getVerificationApi, getRevocationsApi } = await import('@owlid/verifier-client')
    const { challenge } = await getVerificationApi().generateChallenge()

    const passkeyId = await this.passkeyResolver()
    const holderKeyHex = await this.openHolderKey(passkeyId, wrapped)
    // Disclose nothing — revocation needs only proof of possession.
    const presentation = presentSdJwtVc(cred.sdJwtVc, holderKeyHex, [], {
      aud: SELF_REVOKE_AUDIENCE,
      nonce: challenge,
    })

    const res = await getRevocationsApi().revokeOwnCredential({
      revokeOwnCredentialRequest: { presentation, challenge, reason: reason ?? null },
    })
    return {
      revoked: res.revoked,
      credentialId: res.credentialId,
      alreadyRevoked: res.alreadyRevoked,
    }
  }
}

/** Translate the DCQL credential query's OwlID `owl_predicate`
 *  extension to the set of `(predicate, params)` tuples the
 *  orchestrator must ensure are attested on Midnight. Queries
 *  WITHOUT an `owl_predicate` extension contribute nothing —
 *  OwlID's privacy model only honours the extension dispatch path
 *  (spec-strict queries that ask for plaintext disclosure cannot be
 *  satisfied since the wallet never discloses claim values). */
function requiredAttestationsFor(
  query: DcqlCredentialQuery,
  verifierId: string | undefined,
): Array<{
  predicate: string
  threshold?: number
  minAge?: number
  maxAge?: number
  epoch?: string
  appId?: string
  countries?: string[]
  verifierId?: string
}> {
  const ext = readOwlPredicate(query)
  if (!ext) return []
  switch (ext.kind) {
    case 'age_gte':
      return [{ predicate: 'age', threshold: ext.threshold }]
    case 'age_range':
      return [{ predicate: 'age_range', minAge: ext.min, maxAge: ext.max }]
    case 'kyc_gte':
      return [{ predicate: 'kyc', threshold: ext.threshold }]
    case 'nationality_in':
      return [{ predicate: 'nationality', countries: ext.countries, verifierId }]
    case 'residency_in':
      return [{ predicate: 'residency', countries: ext.countries, verifierId }]
    case 'email_verified':
      return [{ predicate: 'email_verified' }]
    case 'unique_personhood':
      return [{ predicate: 'unique_personhood', epoch: ext.epoch, appId: ext.appId }]
  }
}

/** Predicates whose on-chain attestation key carries NO verifier-supplied
 *  input, so they can be attested ahead of any presentation. Verifier-keyed
 *  predicates (`nationality_in`/`resident_in` per-verifier salt, campaign-
 *  scoped `unique_personhood`, arbitrary age thresholds) are excluded — they
 *  can only be attested at presentation time with the verifier's parameters.
 *  `age@18` is included as the overwhelmingly common threshold. */
const PREWARMABLE_PREDICATES: ReadonlyArray<{ predicate: string; threshold?: number }> = [
  { predicate: 'email_verified' },
  { predicate: 'age', threshold: 18 },
]

export interface PrewarmOptions {
  credential: WalletCredential
  /** Override which (predicate, threshold) tuples to pre-attest. Defaults to
   *  the keyless set above; the orchestrator skips any the credential is not
   *  stamped with. */
  predicates?: ReadonlyArray<{ predicate: string; threshold?: number }>
  predicateAssets?: PredicateAssets
  predicateTransport?: PredicateTransport
  onProgress?: (event: AttestProgress) => void
  provingConfig?: ProvingProviderConfig
  signal?: AbortSignal
}

/**
 * Pre-attest a credential's keyless predicates off the presentation hot path —
 * call it (fire-and-forget) right after issuance. By the time the holder ever
 * presents, `isAttested` is already true, so the orchestrator hits the
 * `already-attested` fast path and the presentation never waits on a chain
 * write. Reuses the same prove→relay pipeline as `present()`.
 */
export async function prewarmCredentialAttestations(opts: PrewarmOptions): Promise<EnsureResult[]> {
  return ensureCredentialPredicatesAttested(
    walletCredentialToProofJson(opts.credential),
    opts.predicateAssets ?? createPredicateAssets(),
    opts.predicateTransport ?? createPredicateTransport(),
    opts.onProgress,
    opts.predicates ?? PREWARMABLE_PREDICATES,
    opts.provingConfig,
    opts.signal,
  )
}

/** Build the orchestrator-shaped `Credential.toJson()` view from a
 *  wallet credential: hex credential id (the Midnight Bytes<32> shape),
 *  the holder's stored disclosed claim values, and the issuer-stamped
 *  `owl_attestation` refs lifted off the SD-JWT VC. The orchestrator
 *  reads from this without needing to know about WalletCredential. */
function walletCredentialToProofJson(cred: WalletCredential): string {
  let parsed: SdJwtVc
  try {
    parsed = SdJwtVc.parse(cred.sdJwtVc)
  } catch (e) {
    throw new Error(`Unparseable SD-JWT VC for ${cred.credentialId}: ${String(e)}`)
  }
  const rawAttestation = parsed.disclosedClaim('owl_attestation')
  const baseRefs = Array.isArray(rawAttestation) ? (rawAttestation as OwlAttestationRef[]) : []
  // Same backfill as `readOwlAttestations` (the consent-screen path)
  // so the orchestrator sees the legacy-credential country too. Also
  // normalise the attribute the witness reads (the issuer historically
  // wrote `nationality: "NLD"`; the new circuit witness needs alpha-2).
  const claims = (cred.verifiedClaims as Record<string, unknown>) ?? {}
  const nationalityAlpha2 = alpha2OrUndefined(claims.nationality)
  const residentAlpha2 = alpha2OrUndefined(claims.residentCountry ?? claims.country)
  const refs: OwlAttestationRef[] = baseRefs.map((r) => {
    if (r.country) return r
    if (r.predicate === 'nationality' && nationalityAlpha2) {
      return { ...r, country: nationalityAlpha2 }
    }
    if (r.predicate === 'residency' && residentAlpha2) {
      return { ...r, country: residentAlpha2 }
    }
    return r
  })
  // Normalise the witness-side attributes too so the Compact circuit
  // gets alpha-2 even when the credential stored alpha-3.
  const attributes: Record<string, unknown> = { ...claims }
  if (nationalityAlpha2) attributes.nationality = nationalityAlpha2
  if (residentAlpha2) attributes.residentCountry = residentAlpha2
  return JSON.stringify({
    root_hash: parsed.credentialIdHex(),
    attributes,
    predicate_attestations: refs,
  })
}

/** True iff the credential's `owl_attestation` array carries a
 *  ref that satisfies the verifier's `owl_predicate` extension. */
function owlPredicateCovered(refs: OwlAttestationRef[], ext: OwlPredicate): boolean {
  switch (ext.kind) {
    case 'age_gte':
      // Issuer presence-stamps `age` with no threshold; verifier
      // supplies the threshold at present time.
      return refs.some((r) => r.predicate === 'age')
    case 'age_range':
      return refs.some((r) => r.predicate === 'age_range')
    case 'kyc_gte':
      return refs.some((r) => r.predicate === 'kyc' && r.threshold === ext.threshold)
    case 'nationality_in':
      return refs.some(
        (r) =>
          r.predicate === 'nationality' &&
          typeof r.country === 'string' &&
          ext.countries.map((c) => c.toUpperCase()).includes(r.country.toUpperCase()),
      )
    case 'residency_in':
      return refs.some(
        (r) =>
          r.predicate === 'residency' &&
          typeof r.country === 'string' &&
          ext.countries.map((c) => c.toUpperCase()).includes(r.country.toUpperCase()),
      )
    case 'email_verified':
      return refs.some((r) => r.predicate === 'email_verified')
    case 'unique_personhood':
      // Issuer stamps `unique_personhood` with no scope; scope
      // (epoch, app_id) is presentation-time.
      return refs.some((r) => r.predicate === 'unique_personhood')
  }
}

// ============================================================================
// DCQL matcher — pure function, exported for testing
// ============================================================================

/** Mirror of crates/verification-service/src/dcql.rs `check_credential_query`,
 *  evaluated against the holder's locally-stored disclosed claims. */
export function matchDcqlAgainst(
  credentials: WalletCredential[],
  query: DcqlRequest,
): DcqlMatchSummary {
  const entries: DcqlMatchEntry[] = []
  for (const cq of query.credentials) {
    const candidates = credentials.filter((c) => credentialSatisfies(c, cq))
    const disclosures = disclosuresForQuery(cq)
    entries.push({ dcqlId: cq.id, candidates, disclosures })
  }

  // Default: every credentials[].id is required. credential_sets refines
  // that into alternative combinations.
  const satisfiedIds = new Set(entries.filter((e) => e.candidates.length > 0).map((e) => e.dcqlId))
  const result = checkCredentialSets(query, satisfiedIds)
  return { entries, satisfiable: result.ok, reason: result.reason }
}

function credentialSatisfies(cred: WalletCredential, query: DcqlCredentialQuery): boolean {
  if (query.format !== 'dc+sd-jwt') return false
  if (query.meta?.vctValues && query.meta.vctValues.length > 0) {
    // vct lives inside the SD-JWT VC payload; OwlID issues a single
    // vct so accept conservatively here — server re-checks.
  }
  // All-Midnight policy: a credential satisfies a DCQL query iff its
  // `owl_attestation` array lists the matching predicate ref for the
  // verifier's `owl_predicate` extension. No claim values are ever
  // read. Queries without an `owl_predicate` extension are treated as
  // unsatisfiable — OwlID does not implement the spec-strict
  // plaintext-disclosure path.
  const refs = readOwlAttestations(cred)
  const ext = readOwlPredicate(query)
  if (ext) {
    return owlPredicateCovered(refs, ext)
  }
  // Legacy fallback: the verifier hasn't migrated to `owl_predicate`
  // and is still emitting the old path-as-route shape. Translate any
  // path it sent into the same RoutedPredicate the extension would
  // produce, then check coverage. New verifiers SHOULD use the
  // extension exclusively.
  for (const claim of query.claims ?? []) {
    const path0 = claim.path?.[0]
    if (typeof path0 !== 'string') continue
    const routed = routeClaim(path0, (claim.values ?? []) as unknown[])
    if (!routed) return false // unrouted = no Midnight predicate = unsupported
    if (!attestationCovers(refs, routed)) return false
  }
  return true
}

/** Pull the `owl_attestation` disclosure off the issued SD-JWT VC.
 *  Empty array if missing or malformed — caller treats that as "no
 *  predicates attested" and the credential will fail every routed
 *  check.
 *
 *  Backfills `country` on legacy `nationality` / `residency` refs from
 *  the credential's plaintext claims: pre-refactor issuers stamped the
 *  predicate without a `country` field, so the new set-aware matcher
 *  would reject every old credential. The plaintext value is the same
 *  ISO 3166-1 code the issuer would have written today; normalising
 *  alpha-3 → alpha-2 here keeps wallets that hold Didit creds
 *  (`"NLD"`, `"DEU"`, …) compatible without re-issuance. */
function readOwlAttestations(cred: WalletCredential): OwlAttestationRef[] {
  let parsed: SdJwtVc
  try {
    parsed = SdJwtVc.parse(cred.sdJwtVc)
  } catch {
    return []
  }
  const raw = parsed.disclosedClaim('owl_attestation')
  if (!Array.isArray(raw)) return []
  const refs = raw as OwlAttestationRef[]
  // Backfill `country` on legacy nationality / residency refs from the
  // credential's plaintext claims so pre-refactor credentials still
  // satisfy the new set-aware predicates. New credentials already carry
  // `country` on the ref — the fallback is a no-op for them.
  const claims = (cred.verifiedClaims as Record<string, unknown>) ?? {}
  const nationalityAlpha2 = alpha2OrUndefined(claims.nationality)
  const residentAlpha2 = alpha2OrUndefined(claims.residentCountry ?? claims.country)
  return refs.map((r) => {
    if (r.country) return r
    if (r.predicate === 'nationality' && nationalityAlpha2) {
      return { ...r, country: nationalityAlpha2 }
    }
    if (r.predicate === 'residency' && residentAlpha2) {
      return { ...r, country: residentAlpha2 }
    }
    return r
  })
}

/** Local wrapper around `toAlpha2` from `./countries.js` that tolerates
 *  non-string inputs (the credential's `verifiedClaims` is
 *  `Record<string, unknown>` so callers can't narrow at the call site). */
function alpha2OrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' ? toAlpha2(v) : undefined
}

function disclosuresForQuery(query: DcqlCredentialQuery): string[] {
  // All-Midnight policy: never disclose claim values. The wallet still
  // signs a KB-JWT to prove credential ownership, but the disclosure
  // set is empty — the server checks the requested predicates against
  // the on-chain attestation set instead.
  void query
  return []
}

interface SetCheckResult {
  ok: boolean
  reason?: string
}

function checkCredentialSets(query: DcqlRequest, satisfied: Set<string>): SetCheckResult {
  if (!query.credentialSets) {
    for (const cq of query.credentials) {
      if (!satisfied.has(cq.id)) {
        return { ok: false, reason: `DCQL credential ${cq.id} unsatisfied` }
      }
    }
    return { ok: true }
  }
  for (const set of query.credentialSets) {
    const required = set.required ?? true
    const anyRowOk = set.options.some((row) => row.every((id) => satisfied.has(id)))
    if (required && !anyRowOk) {
      return {
        ok: false,
        reason: `DCQL credential_set unsatisfied: ${JSON.stringify(set.options)}`,
      }
    }
  }
  return { ok: true }
}

interface ChosenCredential {
  dcqlId: string
  credential: WalletCredential
  disclosures: string[]
}

/** Pick one credential per DCQL query id, honouring `credential_sets`
 *  and any user overrides. Greedy newest-first selection — picks the
 *  most-recently-issued candidate per query (latest batch sibling), so
 *  re-presentations rotate through unused one-time-use credentials. */
function chooseAcrossSets(
  summary: DcqlMatchSummary,
  query: DcqlRequest,
  overrides?: Record<string, string>,
): ChosenCredential[] {
  const sets = query.credentialSets
  const idsNeeded = sets
    ? // Pick the first row of each required set; falls back to "all required" if no rows match.
      Array.from(
        new Set(
          (sets ?? []).flatMap((s) => {
            const row = s.options.find((opts) =>
              opts.every((id) =>
                summary.entries.find((e) => e.dcqlId === id && e.candidates.length > 0),
              ),
            )
            return row ?? []
          }),
        ),
      )
    : query.credentials.map((c) => c.id)

  const chosen: ChosenCredential[] = []
  for (const id of idsNeeded) {
    const entry = summary.entries.find((e) => e.dcqlId === id)
    if (!entry || entry.candidates.length === 0) {
      throw new Error(`DCQL id ${id} has no candidate (set solver bug?)`)
    }
    const overrideId = overrides?.[id]
    const explicit = overrideId
      ? entry.candidates.find((c) => c.credentialId === overrideId)
      : undefined
    const credential: WalletCredential =
      explicit ?? [...entry.candidates].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))[0]!
    chosen.push({ dcqlId: id, credential, disclosures: entry.disclosures })
  }
  return chosen
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a === 'object') {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}
