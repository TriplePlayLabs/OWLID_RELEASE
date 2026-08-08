/**
 * INTERNAL — not exported from the package. The transparent one-time
 * step that makes a credential presentation-ready: each predicate the
 * issuer stamped onto the credential is proven once on its kind-specific
 * Midnight contract (witness on device), then reused across every
 * presentation. No Midnight/contract/circuit concept crosses into the
 * SDK consumer — driven entirely by the credential the holder already
 * has + the DCQL routing table.
 *
 * Per-kind dispatch lives in `predicate-assets.ts` and the
 * `PredicatesApi` generated client: one Compact contract per predicate
 * (forced by Midnight's per-extrinsic deploy-weight cap), one URL
 * segment per kind on the verification-service.
 *
 * Mirrors `crates/proof-system/src/predicates.rs` for the family →
 * attribute → Compact-circuit mapping and derives the witness from the
 * credential's own attributes (never a caller parameter).
 */

import { buildOwlRootTree, findClaimPath, salt32For } from './owl-root.js'
import { proveAttestationUnsubmitted } from './prove.js'
import { resolveProvingConfig, type ProvingProviderConfig } from './prover.js'

/** Standard SD-JWT claim name each owl_root-bound predicate opens in-circuit.
 *  All seven predicates bind their witness to the issuer-signed owl_root. */
const OWL_BOUND_CLAIM: Partial<Record<PredicateKind, string>> = {
  kyc: 'verification_level',
  email: 'email_verified',
  nationality: 'nationality',
  residency: 'residentCountry',
  personhood: 'personhoodSecret',
  age: 'birthdate',
  age_range: 'birthdate',
}

/** Date of birth "YYYY-MM-DD" → YYYYMMDD integer (the value the issuer commits
 *  and the age circuits open). */
function dobYmd(dateOfBirth: string): bigint {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOfBirth.trim())
  if (!m) throw new Error(`invalid dateOfBirth: ${dateOfBirth}`)
  return BigInt(Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]))
}

/** First day of the current UTC month as YYYYMM01 — the age freshness epoch.
 *  Mirrors Rust `attestation::current_age_epoch`. */
function currentAgeEpoch(): bigint {
  const now = new Date()
  return BigInt(now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + 1)
}
import type { PredicateSnapshot } from './snapshot.js'
import { bytesToHex, hexToBytes } from '../encoding.js'
import {
  getPredicatesApi,
  streamPredicateStatus,
  type PredicateStatusEvent,
  type RelayProofResponse,
} from '@owlid/verifier-client'
import type { PredicateAssets, PredicateKind, PredicateWitness } from './assets.js'

// ---------------------------------------------------------------------------
// Predicate attestation name space ↔ sidecar URL kind space
// ---------------------------------------------------------------------------
//
// The issuer stamps `predicate_attestations` entries with Rust-side
// canonical names (`age`, `kyc`, `nationality`, `residency`,
// `age_range`, `email_verified`, `unique_personhood` — mirroring
// `crates/proof-system/src/attestation.rs`). The sidecar deploys one
// Compact contract per kind under shorter URL-safe segments (`age`,
// `kyc`, `residency`, `email`, `nationality`, `age_range`,
// `personhood`). The orchestrator translates between the two — the
// verifier-side `/predicates/attested` endpoint stays in the
// attestation name space, the per-kind snapshot/relay endpoints stay
// in the sidecar URL kind space.
const PREDICATE_NAME_TO_KIND: Record<string, PredicateKind | undefined> = {
  age: 'age',
  kyc: 'kyc',
  residency: 'residency',
  email_verified: 'email',
  nationality: 'nationality',
  age_range: 'age_range',
  unique_personhood: 'personhood',
}

/** Per-family wiring: which Compact contract + circuit, and how to
 *  turn the credential's plaintext attribute into the witness + public
 *  args. The threshold (or `(min, max)` range) comes from the
 *  issuer-stamped attestation (already numeric). Families: age /
 *  age_range / kyc / residency / email_verified / nationality /
 *  unique_personhood. */
interface FamilySpec {
  kind: PredicateKind
  circuitId: string
  attribute: string
  witness(attrs: Record<string, unknown>): PredicateWitness
}

const FAMILIES: Record<string, FamilySpec | undefined> = {
  age: {
    kind: 'age',
    circuitId: 'attestAgeGte',
    attribute: 'dateOfBirth',
    witness(attrs) {
      return { dobValue: dobYmd(String(attrs['dateOfBirth'])) }
    },
  },
  age_range: {
    kind: 'age_range',
    circuitId: 'attestAgeRange',
    attribute: 'dateOfBirth',
    witness(attrs) {
      return { dobValue: dobYmd(String(attrs['dateOfBirth'])) }
    },
  },
  kyc: {
    kind: 'kyc',
    circuitId: 'attestKycGte',
    attribute: 'verificationLevel',
    witness(attrs) {
      return { kycLevel: BigInt(kycLevelToNumber(attrs['verificationLevel'])) }
    },
  },
  residency: {
    kind: 'residency',
    circuitId: 'attestResidencyIn',
    attribute: 'residentCountry',
    witness(attrs) {
      return { residentCountry: normalizeCountry(attrs['residentCountry']) }
    },
  },
  email_verified: {
    kind: 'email',
    circuitId: 'attestEmailVerified',
    attribute: 'emailVerified',
    witness(attrs) {
      return { emailVerifiedFlag: BigInt(emailVerifiedToNumber(attrs['emailVerified'])) }
    },
  },
  nationality: {
    kind: 'nationality',
    circuitId: 'attestNationalityIn',
    attribute: 'nationality',
    witness(attrs) {
      return { nationalityCode: normalizeCountry(attrs['nationality']) }
    },
  },
  unique_personhood: {
    kind: 'personhood',
    circuitId: 'attestUniquePersonhood',
    // Holder-only 32-byte witness, issuer-derived per real human; lives
    // in the credential's local verifiedClaims, never an SD-JWT claim.
    attribute: 'personhoodSecret',
    witness(attrs) {
      return { personhoodSecret: hexToBytes(String(attrs['personhoodSecret'])) }
    },
  },
}

/** verificationLevel may be a number or a label. Accepts both the
 *  eIDAS naming (`basic` / `substantial` / `high`) and the
 *  provider-driven naming (`low` / `medium` / `high` / `none`). */
function kycLevelToNumber(v: unknown): number {
  if (typeof v === 'number') return v
  const s = String(v).toLowerCase()
  switch (s) {
    case '0':
    case 'none':
    case '':
      return 0
    case '1':
    case 'low':
    case 'basic':
      return 1
    case '2':
    case 'medium':
    case 'substantial':
      return 2
    case '3':
    case 'high':
      return 3
  }
  const n = Number(s)
  if (!Number.isNaN(n)) return n
  throw new Error(`unrecognised verificationLevel: ${v}`)
}

/** Coerce a credential attribute to an ISO 3166-1 alpha-2 country code,
 *  upper-cased. Throws on shapes that can't be normalised — the orchestrator
 *  treats that as "skip this predicate" via the `skip-unsatisfiable` event. */
function normalizeCountry(v: unknown): string {
  if (typeof v !== 'string') throw new Error(`unrecognised country: ${v}`)
  const trimmed = v.trim().toUpperCase()
  if (trimmed.length !== 2 || !/^[A-Z]{2}$/.test(trimmed)) {
    throw new Error(`country must be ISO 3166-1 alpha-2: got "${v}"`)
  }
  return trimmed
}

/** Canonicalise a verifier-supplied country list: uppercase, drop
 *  malformed, dedupe, sort lexicographically. Mirrors the Rust
 *  `canonicalise_countries` so both sides hash the same bytes. */
function canonicaliseCountries(codes: ReadonlyArray<string>): string[] {
  const seen = new Set<string>()
  for (const raw of codes) {
    if (typeof raw !== 'string') continue
    const code = raw.trim().toUpperCase()
    if (code.length === 2 && /^[A-Z]{2}$/.test(code)) seen.add(code)
  }
  return [...seen].sort()
}

import { buildAllowedSetTree, treeRootBytesLE, COUNTRY_SET_SLOTS } from './merkle.js'

/** Off-chain `setHash` recipe — mirrors the Compact circuit:
 *    root    = merkleTreePathRootNoLeafHash(sorted+padded allowed-set)
 *    setHash = SHA-256( verifierIdHash || rootBytesLE )
 *  Identical to `owl_proof_system::attestation::allowed_country_set_hash`. */
async function computeSetHash(
  verifierIdHash: Uint8Array,
  canonCountries: ReadonlyArray<string>,
): Promise<Uint8Array> {
  if (canonCountries.length > COUNTRY_SET_SLOTS) {
    throw new Error(
      `allowedCountrySet exceeds cap: ${canonCountries.length} > ${COUNTRY_SET_SLOTS}`,
    )
  }
  const { tree } = buildAllowedSetTree(canonCountries)
  const rootBytes = treeRootBytesLE(tree)
  const outer = new Uint8Array(64)
  outer.set(verifierIdHash, 0)
  outer.set(rootBytes, 32)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', outer))
}

/** SHA-256 of the verifier `client_id` UTF-8 bytes — same value the
 *  Compact `verifierIdHash()` witness returns. */
async function computeVerifierIdHash(verifierId: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(verifierId)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

/** Effective personhood scope: the verifier's campaign `appId` bound under
 *  its authenticated identity — `SHA-256(verifierIdHash(client_id) || appId)`.
 *  Mirror of Rust `attestation::personhood_app_id`. */
async function personhoodAppId(verifierId: string, appId: Uint8Array): Promise<Uint8Array> {
  const vidHash = await computeVerifierIdHash(verifierId)
  const buf = new Uint8Array(64)
  buf.set(vidHash, 0)
  buf.set(appId.subarray(0, 32), 32)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf))
}

/** emailVerified is typically a boolean from OIDC providers; tolerate
 *  the same string/number coercions as isResident for robustness. */
function emailVerifiedToNumber(v: unknown): number {
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v >= 1 ? 1 : 0
  const s = String(v).toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes') return 1
  if (s === 'false' || s === '0' || s === 'no' || s === '') return 0
  throw new Error(`unrecognised emailVerified: ${v}`)
}

// ---------------------------------------------------------------------------
// Transport over the generated verifier-client (the SDK is the only
// dev surface — never a raw fetch, never a sidecar URL).
// ---------------------------------------------------------------------------

/** Transport for the idempotency check + per-kind snapshot/relay. */
export interface PredicateTransport {
  /** `/predicates/attested` — predicate-attestation name space
   *  (`age|kyc|nationality|residency|age_range|email_verified|
   *  unique_personhood`). `epoch`/`appId` (32-byte hex) are the
   *  presentation-time scope of `unique_personhood` only. */
  isAttested(args: {
    predicate: string
    rootHash: string
    /** Issuer-signed `owl_root` (hex). Every predicate attestation key binds
     *  it (F-1); the server rejects the check without it. */
    owlRoot?: string
    threshold?: number
    minAge?: number
    maxAge?: number
    epoch?: string
    appId?: string
    /** Verifier-supplied allowed set for `nationality` / `residency`. */
    countries?: string[]
    /** OID4VP verifier `client_id` — required for `nationality` /
     *  `residency` so the verification-service derives the same
     *  per-verifier salt the on-chain key was minted against. */
    verifierId?: string
  }): Promise<boolean>
  /** `/predicates/{kind}/snapshot` — sidecar URL kind space. */
  snapshot(kind: PredicateKind): Promise<PredicateSnapshot>
  /** `/predicates/{kind}/relay` — sidecar URL kind space. Fire-and-forget:
   *  the sidecar accepts the proven tx, runs balanceTx + submitTx in
   *  the background, and returns `{txId, status: 'queued'}` in ≤10 ms.
   *  Subscribe to {@link statusEvents} with the returned txId for
   *  phase transitions. */
  relay(kind: PredicateKind, provenTxHex: string): Promise<RelayProofResponse>
  /** SSE subscription to phase transitions for a relay job (or raw
   *  chain tx). One event per real transition pushed by the sidecar's
   *  in-process eventBus; the stream completes on terminal status.
   *  The whole system uses two notification transports end-to-end:
   *  WS for two-way channels, SSE for server→client pushes. No
   *  polling. */
  statusEvents(jobId: string, signal?: AbortSignal): AsyncIterable<PredicateStatusEvent>
}

/** Retry a GET-ish fetch on transient `TypeError: Failed to fetch`
 *  with exponential backoff. The verification-service routes used by
 *  the holder are GET-only and idempotent (snapshot, isAttested), so
 *  a retry never double-acts on the chain. */
async function retryFetch<T>(fn: () => Promise<T>, attempts = 3, baseMs = 250): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const transient =
        e instanceof TypeError && typeof e.message === 'string' && e.message.includes('fetch')
      if (!transient) throw e
      if (i === attempts - 1) break
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i))
    }
  }
  throw lastErr
}

/**
 * Concrete transport over the SDK's existing verification-service
 * client (`getPredicatesApi` auto-configures from `@owlid/config` — the
 * same endpoint/apiKey as `OwlVerifier`). No new endpoint, no raw fetch,
 * no sidecar exposure.
 */
export function createPredicateTransport(): PredicateTransport {
  const api = getPredicatesApi()
  return {
    async isAttested({
      predicate,
      rootHash,
      owlRoot,
      threshold,
      minAge,
      maxAge,
      epoch,
      appId,
      countries,
      verifierId,
    }) {
      const r = await api.checkPredicateAttested({
        checkPredicateRequest: {
          credentialId: rootHash,
          owlRoot,
          predicate,
          threshold,
          minAge,
          maxAge,
          epoch,
          appId,
          countries,
          verifierId,
        },
      })
      return r.attested
    },
    async snapshot(kind) {
      // Snapshot is GET-only, idempotent, and the only network step
      // before WASM proving. A transient `TypeError: Failed to fetch`
      // (mid-Cloud-Run cold start, brief WS reconnect, etc.) used to
      // abort the whole presentation. Retry up to 3 attempts with
      // exponential backoff (250 → 500 → 1000 ms).
      const s = await retryFetch(() => api.getPredicateSnapshot({ kind }))
      return {
        address: s.address,
        zswapChainState: s.zswapChainState,
        contractState: s.contractState,
        ledgerParameters: s.ledgerParameters,
      }
    },
    async relay(kind, provenTxHex) {
      return api.relayPredicateProof({ kind, relayProofRequest: { provenTx: provenTxHex } })
    },
    statusEvents(jobId, signal) {
      return streamPredicateStatus(jobId, { signal })
    },
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface EnsureResult {
  predicate: string
  threshold?: number
  /** Already on-chain ⇒ no proving/submit happened. */
  alreadyOnChain: boolean
}

/** Phases the orchestrator passes through per predicate; surfaced to
 *  the holder UI so it can show "Generating proof for X…" / "Submitting
 *  to Midnight…" instead of a silent ~20-30s pause on first use. */
export type AttestProgress =
  | { stage: 'check'; predicate: string }
  | { stage: 'already-attested'; predicate: string }
  | { stage: 'snapshot'; predicate: string; kind: PredicateKind }
  /** `mode` reflects the resolved proving backend at the moment the
   *  circuit started: `wasm` = in-process zkir-v2 (witness never
   *  leaves the device); `proof-server` = preimage POSTed to the
   *  configured Midnight proof server. UI uses it to label the step
   *  accurately ("on your device" vs "on the proof server"). */
  | {
      stage: 'prove'
      predicate: string
      kind: PredicateKind
      circuitId: string
      mode: 'wasm' | 'proof-server'
    }
  | { stage: 'relay'; predicate: string; kind: PredicateKind }
  /** Sidecar accepted the proven tx; chain is finalizing. Emitted
   *  every poll (~5 s) with the elapsed time since the holder posted
   *  the relay request and the current backend phase, so the UI can
   *  render a live timer + phase label instead of a generic spinner.
   *
   *  Phases:
   *    - `queued`      job accepted, balanceTx not yet started
   *    - `balancing`   wallet is constructing inputs/outputs/fees
   *    - `submitting`  balanced tx posted to the Polkadot node, awaiting txId
   *    - `pending`     chain has the txId but hasn't yet finalized
   *  (`jobId` is the sidecar's local handle returned by /relay; the
   *  chain tx-id only becomes available after `submitTx` returns and
   *  is surfaced separately on the `attested` event.) */
  | {
      stage: 'confirming'
      predicate: string
      kind: PredicateKind
      jobId: string
      elapsedMs: number
      phase: 'queued' | 'balancing' | 'submitting' | 'pending'
    }
  | { stage: 'attested'; predicate: string; kind: PredicateKind }
  | { stage: 'skip-unsupported'; predicate: string }
  | { stage: 'skip-missing-attribute'; predicate: string; attribute: string }
  | {
      stage: 'skip-unsatisfiable'
      predicate: string
      threshold?: number
      actual?: number
      reason: string
    }
  /** Wallet unlock — the passkey UV prompt is about to appear so the
   *  holder seed can be decrypted before KB-JWT signing. Emitted by
   *  `OwlWallet.present`, not the orchestrator itself. */
  | { stage: 'unlock'; predicate: string }
  /** Holder is signing the KB-JWT for this credential. Emitted by
   *  `OwlWallet.present` once per chosen credential. */
  | { stage: 'sign'; predicate: string }

interface StampedAttestation {
  predicate: string
  threshold?: number
  min_age?: number
  max_age?: number
  epoch?: string
  app_id?: string
  /** For `nationality` / `residency`: the holder's actual country
   *  (ISO 3166-1 alpha-2) the issuer stamped on the credential. The
   *  wallet checks the verifier's allowed-set contains this code. */
  country?: string
}

interface CredentialJson {
  root_hash: string
  /** Issuer-signed predicate-binding commitment (hex); absent for pre-owl_root
   *  credentials. */
  owl_root?: string | null
  /** Raw `{name,value,salt}` disclosures — inputs to the owl_root tree the
   *  wallet rebuilds to extract a claim's Merkle path (F-1 binding). */
  claim_disclosures?: Array<{ name: string; value: unknown; salt: string }>
  attributes: Record<string, unknown>
  predicate_attestations?: StampedAttestation[]
}

/**
 * Ensure every predicate the issuer stamped onto this credential is
 * proven on its kind-specific Midnight contract. Idempotent and
 * one-time per (credential, predicate, threshold): the steady state is
 * a single cheap `isAttested` round-trip per predicate. Witness is
 * derived from the credential's own attributes and never leaves the
 * device — only the resulting (witness-stripped) proven tx is relayed.
 *
 * Predicates the SDK has no Compact mapping for are silently skipped —
 * the orchestrator returns no `EnsureResult` for them.
 * `unique_personhood` is proved only when the verifier's DCQL supplied
 * its `(epoch, appId)` campaign scope via `required`.
 *
 * @param credentialJson `Credential.toJson()` — the serialized
 *   ProofDocument the holder already holds.
 */
export async function ensureCredentialPredicatesAttested(
  credentialJson: string,
  assets: PredicateAssets,
  transport: PredicateTransport,
  onProgress?: (event: AttestProgress) => void,
  /** Subset of stamped predicates the caller actually needs attested
   *  (typically derived from the verifier's DCQL). When set, the
   *  orchestrator only proves matching `(predicate, threshold)` tuples
   *  — extra issuer-stamped attestations the verifier doesn't ask for
   *  are silently skipped. When `undefined`, every stamped predicate
   *  is attempted (legacy "attest everything at issuance" behaviour).
   *
   *  `epoch`/`appId` (32-byte hex) carry the verifier's campaign scope
   *  for `unique_personhood` — the issuer stamps that predicate with no
   *  scope, so the orchestrator can only prove it when the DCQL supplied
   *  one here. */
  required?: ReadonlyArray<{
    predicate: string
    threshold?: number
    minAge?: number
    maxAge?: number
    epoch?: string
    appId?: string
    /** For `nationality` / `residency`: the verifier-supplied allowed
     *  country set (ISO 3166-1 alpha-2, ≤64 codes). Binds the on-chain
     *  key — different sets ⇒ different attestations. */
    countries?: string[]
    /** For `nationality` / `residency`: the OID4VP verifier `client_id`
     *  (typically response_uri). Folded into the on-chain attestation
     *  key as a per-verifier salt, so two verifiers asking the same
     *  allowed-set still produce distinct keys. Required whenever
     *  `countries` is set. */
    verifierId?: string
  }>,
  /** Override the global `@owlid/config` proving mode for this run. */
  provingConfig?: ProvingProviderConfig,
  /** Caller-controlled abort. When fired, in-flight SSE subscriptions
   *  are torn down via `transport.statusEvents`'s `signal` and the
   *  for-await loop exits — preventing orphan stream traffic when the
   *  holder cancels the consent dialog. */
  signal?: AbortSignal,
): Promise<EnsureResult[]> {
  const doc = JSON.parse(credentialJson) as CredentialJson
  const stamped = doc.predicate_attestations ?? []
  if (stamped.length === 0) return []
  const emit = (e: AttestProgress) => {
    try {
      onProgress?.(e)
    } catch {
      /* progress callbacks must not block proving */
    }
  }

  const isRequired = (sp: StampedAttestation): boolean => {
    if (!required) return true
    // `age` / `age_range` are presence-stamped — the threshold / bounds
    // are presentation-time, supplied by the verifier's DCQL, so match
    // by predicate name only.
    // `nationality` / `residency` are country-stamped — the allowed-set
    // is presentation-time too, so match by predicate name + presence
    // of holder's stamped country in the verifier's requested set.
    // `kyc` is a fixed tier, so its on-chain key encodes the exact
    // threshold — require exact match there.
    return required.some((r) => {
      if (r.predicate !== sp.predicate) return false
      if (sp.predicate === 'age' || sp.predicate === 'age_range') return true
      if (sp.predicate === 'nationality' || sp.predicate === 'residency') {
        if (!r.countries || r.countries.length === 0) return false
        const stamped = sp.country?.toUpperCase()
        return stamped !== undefined && r.countries.includes(stamped)
      }
      return r.threshold === sp.threshold
    })
  }

  // A cancel (holder closes the modal / taps Cancel) aborts `signal`.
  // We surface that as an AbortError so it propagates as a user cancel
  // (the caller swallows it) rather than a predicate failure.
  const abortError = () =>
    Object.assign(new Error('Presentation aborted by holder'), { name: 'AbortError' })

  const results: EnsureResult[] = []
  for (const sp of stamped) {
    if (!isRequired(sp)) continue
    const spec = FAMILIES[sp.predicate]
    if (!spec) {
      emit({ stage: 'skip-unsupported', predicate: sp.predicate })
      continue
    }
    if (doc.attributes[spec.attribute] === undefined) {
      emit({ stage: 'skip-missing-attribute', predicate: sp.predicate, attribute: spec.attribute })
      continue
    }

    // `unique_personhood` is scoped per (epoch, app_id) by the
    // verifier's campaign DCQL — the issuer stamps it open. Pull the
    // scope from the matching `required` entry; with no scope there is
    // nothing to attest against, so skip rather than guess.
    // `appId` is the raw campaign id (sent to the verifier service, which
    // binds it); `effectiveAppId` is that campaign bound under the verifier
    // identity — the value the circuit actually nullifies on.
    let scope: { epoch: string; appId: string; effectiveAppId: string } | undefined
    if (spec.kind === 'personhood') {
      const reqEntry = required?.find(
        (r) => r.predicate === sp.predicate && !!r.epoch && !!r.appId && !!r.verifierId,
      )
      if (!reqEntry?.epoch || !reqEntry.appId || !reqEntry.verifierId) {
        emit({ stage: 'skip-unsupported', predicate: sp.predicate })
        continue
      }
      // F-2: the verifier's campaign appId stays meaningful (per-campaign
      // sybil scope) but is bound under its authenticated client_id, so a
      // different verifier choosing the same campaign cannot share the
      // nullifier namespace and no verifier can force a foreign scope. Same
      // recipe the verification-service uses (attestation::personhood_app_id):
      // SHA-256(verifierIdHash(client_id) || appId).
      const effectiveAppId = bytesToHex(
        await personhoodAppId(reqEntry.verifierId, hexToBytes(reqEntry.appId)),
      )
      scope = { epoch: reqEntry.epoch, appId: reqEntry.appId, effectiveAppId }
    }

    // `age` / `age_range` are presence-stamped — the threshold / bounds
    // are presentation-time, supplied by the verifier's DCQL. Pull them
    // from the matching `required` entry. With no `required` (legacy
    // "attest everything" path) there is no verifier input, so skip:
    // there is no threshold to prove against.
    let threshold: number | undefined = sp.threshold
    let minAge: number | undefined = sp.min_age
    let maxAge: number | undefined = sp.max_age
    if (spec.kind === 'age' || spec.kind === 'age_range') {
      const reqEntry = required?.find((r) => r.predicate === sp.predicate)
      if (!reqEntry) {
        emit({ stage: 'skip-unsupported', predicate: sp.predicate })
        continue
      }
      threshold = reqEntry.threshold
      minAge = reqEntry.minAge
      maxAge = reqEntry.maxAge
    }

    // `nationality` / `residency` are country-stamped — the allowed
    // country set + verifier identity are presentation-time, supplied
    // by the verifier's DCQL + OID4VP `client_id`. The wallet
    // canonicalises the set (sort, dedupe, uppercase) and pre-computes
    // the public-arg `setHash` so the circuit only takes 32 bytes; the
    // set itself, the country, and the verifier-id hash all live in
    // the prover's witnesses. Without all three the on-chain key can't
    // be formed correctly, so skip.
    let canonCountries: string[] | undefined
    let verifierIdHashBytes: Uint8Array | undefined
    let setHashBytes: Uint8Array | undefined
    if (sp.predicate === 'nationality' || sp.predicate === 'residency') {
      const reqEntry = required?.find((r) => r.predicate === sp.predicate)
      if (!reqEntry?.countries || reqEntry.countries.length === 0) {
        emit({ stage: 'skip-unsupported', predicate: sp.predicate })
        continue
      }
      if (!reqEntry.verifierId) {
        emit({
          stage: 'skip-unsatisfiable',
          predicate: sp.predicate,
          reason: 'verifierId required for nationality / residency (per-verifier salt)',
        })
        continue
      }
      canonCountries = canonicaliseCountries(reqEntry.countries)
      if (canonCountries.length === 0) {
        emit({
          stage: 'skip-unsatisfiable',
          predicate: sp.predicate,
          reason: 'verifier-supplied country list contained no valid alpha-2 codes',
        })
        continue
      }
      const stamped = sp.country?.toUpperCase()
      if (!stamped || !canonCountries.includes(stamped)) {
        emit({
          stage: 'skip-unsatisfiable',
          predicate: sp.predicate,
          reason: `credential stamped country ${sp.country ?? '<none>'} not in verifier set ${canonCountries.join(',')}`,
        })
        continue
      }
      verifierIdHashBytes = await computeVerifierIdHash(reqEntry.verifierId)
      setHashBytes = await computeSetHash(verifierIdHashBytes, canonCountries)
    }

    emit({ stage: 'check', predicate: sp.predicate })
    // F-1 binding: every predicate anchors its attestation key on the
    // issuer-signed owl_root (not the credential id) so the key the verifier
    // recomputes matches what the bound circuit records.
    const bindsOwlRoot =
      OWL_BOUND_CLAIM[spec.kind] !== undefined && typeof doc.owl_root === 'string'
    const anchorHex = bindsOwlRoot ? (doc.owl_root as string) : doc.root_hash
    // Every predicate attestation key binds the issuer-signed owl_root (F-1);
    // the /attested check and the on-chain key both require it. A credential
    // issued before owl_root can't satisfy any predicate — skip it with a
    // reissue hint rather than firing a request the server 400s on
    // ("owl_root required"), which would abort the whole presentation.
    if (!bindsOwlRoot) {
      emit({
        stage: 'skip-unsatisfiable',
        predicate: sp.predicate,
        threshold,
        reason: 'credential predates owl_root binding — request a fresh credential',
      })
      continue
    }
    // Reused twice: the up-front membership check and, on a personhood
    // replay failure below, a re-check of THIS credential's attest key.
    const attestQuery = {
      predicate: sp.predicate,
      rootHash: anchorHex,
      owlRoot: doc.owl_root as string,
      threshold,
      minAge,
      maxAge,
      epoch: scope?.epoch,
      appId: scope?.appId,
      countries: canonCountries,
      verifierId:
        sp.predicate === 'nationality' ||
        sp.predicate === 'residency' ||
        sp.predicate === 'unique_personhood'
          ? required?.find((r) => r.predicate === sp.predicate)?.verifierId
          : undefined,
    }
    if (await transport.isAttested(attestQuery)) {
      emit({ stage: 'already-attested', predicate: sp.predicate })
      results.push({ predicate: sp.predicate, threshold, alreadyOnChain: true })
      continue
    }

    let witness
    try {
      witness = spec.witness(doc.attributes)
    } catch (e) {
      emit({
        stage: 'skip-unsatisfiable',
        predicate: sp.predicate,
        threshold,
        reason: e instanceof Error ? e.message : String(e),
      })
      continue
    }

    // Augment witness with allowedCountrySet + verifierIdHash for the
    // set-membership predicates; the circuit asserts that the witness
    // produces the same setHash as the public arg.
    if (canonCountries && verifierIdHashBytes) {
      witness = {
        ...witness,
        allowedCountrySet: canonCountries,
        verifierIdHash: verifierIdHashBytes,
      }
    }

    // F-1 binding witness: prove the claim value is the one the issuer
    // committed under owl_root. Build the same tree the issuer signed from the
    // raw disclosures and extract this claim's Merkle path; the circuit folds
    // it to owl_root and rejects any fabricated value (no valid path).
    if (bindsOwlRoot) {
      const claimName = OWL_BOUND_CLAIM[spec.kind]
      if (!claimName) throw new Error(`no owl_root claim mapping for ${spec.kind}`)
      try {
        const built = buildOwlRootTree(doc.claim_disclosures ?? [])
        const salt = (doc.claim_disclosures ?? []).find((d) => d.name === claimName)?.salt
        if (salt === undefined) throw new Error(`no disclosure salt for ${claimName}`)
        witness = {
          ...witness,
          claimSalt: salt32For(salt),
          claimPath: findClaimPath(built, claimName),
        }
      } catch (e) {
        emit({
          stage: 'skip-unsatisfiable',
          predicate: sp.predicate,
          threshold,
          reason: `owl_root binding unavailable: ${e instanceof Error ? e.message : String(e)}`,
        })
        continue
      }
    }

    // Pre-flight: the Compact circuit asserts `value >= threshold` on
    // device. If the credential carries a stamped predicate that the
    // value doesn't satisfy (typically an older credential issued
    // before the issuer-side filter landed), the prove step will throw
    // 'failed assert: <kind> below threshold' and break the whole
    // presentation. Skip the predicate here and continue — the verifier
    // will reject the presentation only if the DCQL actually required
    // this predicate.
    const actual = numericWitnessValue(spec.kind, witness)
    if (threshold !== undefined && actual !== undefined && actual < threshold) {
      emit({
        stage: 'skip-unsatisfiable',
        predicate: sp.predicate,
        threshold,
        actual,
        reason: `credential's ${spec.attribute}=${actual} < required ${threshold}`,
      })
      continue
    }

    const rootBytes = hexToBytes(anchorHex)
    // Per-circuit public arg shape:
    //   attestUniquePersonhood(rootHash, epoch, appId)
    //   attestAgeRange(rootHash, minAge, maxAge)
    //   attestNationalityIn / attestResidencyIn(rootHash, setHash) — set
    //     + verifierIdHash live in the witness; setHash is its hash
    //   age/kyc presence-only with optional threshold
    // age / age_range now take the freshness epoch (asOfYmd) as a bound public
    // arg; age requires a threshold (the bound circuit has no presence-only form).
    const ageEpoch = currentAgeEpoch()
    const args = scope
      ? [rootBytes, hexToBytes(scope.epoch), hexToBytes(scope.effectiveAppId)]
      : spec.kind === 'age_range'
        ? [rootBytes, BigInt(minAge!), BigInt(maxAge!), ageEpoch]
        : spec.kind === 'age'
          ? [rootBytes, BigInt(threshold ?? 18), ageEpoch]
          : setHashBytes !== undefined
            ? [rootBytes, setHashBytes]
            : threshold === undefined
              ? [rootBytes]
              : [rootBytes, BigInt(threshold)]
    // Cancel checkpoint BEFORE the expensive prove + relay. A relay POST
    // makes the sidecar submit an attest tx on-chain (detached, ~10ms
    // ack), so relaying after the holder cancelled would write to chain
    // and spend DUST post-cancel. Thrown OUTSIDE the try below so it
    // propagates as an abort instead of being swallowed as
    // skip-unsatisfiable.
    if (signal?.aborted) throw abortError()
    // Optimistic concurrency. The holder proves against an indexer snapshot
    // that already trails the node by a couple of blocks, and every
    // attestation to the SAME predicate contract mutates one shared
    // `attestTree`. Any other attestation landing inside the
    // prove -> relay -> include window supersedes the root the transcript was
    // built on, so the fallible section is rejected on replay. Re-proving
    // against a fresh snapshot is the resolution.
    const MAX_ATTEST_ATTEMPTS = 3
    let attestSkipped = false
    let attestSettled = false
    for (let attempt = 1; attempt <= MAX_ATTEST_ATTEMPTS; attempt++) {
      emit({ stage: 'snapshot', predicate: sp.predicate, kind: spec.kind })
      const resolvedProving = resolveProvingConfig(provingConfig)
      let provenTx: Uint8Array
      try {
        // Snapshot fetch lives INSIDE the try so a kind whose contract is
        // undeployed/unconfigured (sidecar 400 "no configured address") or
        // a transient snapshot failure degrades to a per-predicate skip —
        // the verifier rejects only if it actually required this predicate.
        // Previously this ran outside the try and a single bad kind (e.g.
        // `email`) aborted the entire presentation.
        const snapshot = await transport.snapshot(spec.kind)
        emit({
          stage: 'prove',
          predicate: sp.predicate,
          kind: spec.kind,
          circuitId: spec.circuitId,
          mode: resolvedProving.mode,
        })
        provenTx = await proveAttestationUnsubmitted({
          compiledContract: assets.compiledContract(spec.kind, witness),
          zkConfigProvider: assets.zkConfigProvider,
          snapshot,
          circuitId: spec.circuitId,
          args,
          privateStateId: `owlid-predicate-${spec.kind}`,
          proofProvider: resolvedProving,
        })
      } catch (e) {
        // Catches: snapshot fetch failures (undeployed/unconfigured kind,
        // transient network), stale stamped attestations the witness can't
        // satisfy even after the pre-flight (e.g. nationality set drift),
        // zkir failures. The whole presentation continues — the verifier
        // rejects only if this predicate was required by the DCQL.
        const msg = e instanceof Error ? e.message : String(e)
        emit({
          stage: 'skip-unsatisfiable',
          predicate: sp.predicate,
          threshold,
          reason: `attestation prep failed: ${msg}`,
        })
        attestSkipped = true
        break
      }
      // The WASM prove above is not interruptible; the holder may have
      // cancelled while it ran. Re-check before relaying so no attest tx
      // hits the chain post-cancel.
      if (signal?.aborted) throw abortError()
      emit({ stage: 'relay', predicate: sp.predicate, kind: spec.kind })
      // /relay returns a job-id in ≤10 ms. The sidecar runs
      // balanceTx + submitTx in the background and pushes phase
      // transitions over SSE. We subscribe to that stream once and
      // emit one `confirming` event per push, completing on the
      // terminal status. No polling at any layer.
      const submit = await transport.relay(spec.kind, bytesToHex(provenTx))
      const jobId = submit.jobId
      if (!jobId) {
        throw new Error(`relay for '${sp.predicate}' returned no jobId`)
      }
      const submitTs = Date.now()
      const IN_FLIGHT = new Set(['queued', 'balancing', 'submitting'])
      const SUCCESS = 'SucceedEntirely'
      const ABORT_BUDGET_MS = 5 * 60_000
      // Chain the caller's signal so cancelling the wallet.present()
      // promise upstream actually closes the SSE socket — without this
      // the holder modal can close while the orchestrator keeps
      // streaming until the chain finality or the budget timer fires.
      const abort = new AbortController()
      const onCallerAbort = () => abort.abort()
      if (signal) {
        if (signal.aborted) abort.abort()
        else signal.addEventListener('abort', onCallerAbort, { once: true })
      }
      const budgetTimer = setTimeout(() => abort.abort(), ABORT_BUDGET_MS)
      let terminal: string | null = null
      let terminalError: string | undefined
      try {
        for await (const ev of transport.statusEvents(jobId, abort.signal)) {
          if (IN_FLIGHT.has(ev.status)) {
            emit({
              stage: 'confirming',
              predicate: sp.predicate,
              kind: spec.kind,
              jobId,
              elapsedMs: Date.now() - submitTs,
              phase: ev.status as 'queued' | 'balancing' | 'submitting' | 'pending',
            })
            continue
          }
          if (ev.status === 'submitted') {
            // Job moved into the chain-finalization phase. UI keeps
            // the "submitting" → "pending" label until the chain emits
            // a terminal status; surface it as `pending` here.
            emit({
              stage: 'confirming',
              predicate: sp.predicate,
              kind: spec.kind,
              jobId,
              elapsedMs: Date.now() - submitTs,
              phase: 'pending',
            })
            continue
          }
          terminal = ev.status
          terminalError = ev.error
          break
        }
      } finally {
        clearTimeout(budgetTimer)
        abort.abort()
        signal?.removeEventListener('abort', onCallerAbort)
      }
      if (signal?.aborted) {
        throw new Error(`presentation aborted by caller (jobId=${jobId})`)
      }
      if (terminal === null) {
        throw new Error(
          `on-chain attestation for '${sp.predicate}' timed out after ${ABORT_BUDGET_MS}ms (jobId=${jobId})`,
        )
      }
      if (terminal !== SUCCESS) {
        // A concurrent (or prior) presentation in the same campaign may have
        // already inserted this credential's personhood nullifier; the racing
        // tx then fails the on-chain `personhood replay` assert even though the
        // attestation it duplicates is on chain. Re-check THIS credential's
        // attest key (the nullifier can be per-person, so a replay alone does
        // not prove MY key landed) — if it is now attested, the goal is met, so
        // treat it as already-attested instead of failing the presentation.
        if (
          sp.predicate === 'unique_personhood' &&
          (terminalError ?? '').toLowerCase().includes('personhood replay') &&
          (await transport.isAttested(attestQuery))
        ) {
          emit({ stage: 'already-attested', predicate: sp.predicate })
          results.push({ predicate: sp.predicate, threshold, alreadyOnChain: true })
          attestSettled = true
          break
        }
        // The goal is "this key is attested on chain", not "my transaction is
        // the one that put it there". A `FailFallible` means the fallible
        // section was rejected when replayed against the ledger — which happens
        // when the state moved between the snapshot the holder proved against
        // and inclusion (a concurrent attest, or the sidecar's cached state
        // lagging the chain right after a contract redeploy). `record()` is
        // idempotent, so the key may well be present regardless. Ask the chain
        // before failing a presentation the holder can do nothing about.
        if (await transport.isAttested(attestQuery)) {
          emit({ stage: 'already-attested', predicate: sp.predicate })
          results.push({ predicate: sp.predicate, threshold, alreadyOnChain: true })
          attestSettled = true
          break
        }
        // `FailFallible` means the fallible section was rejected when replayed
        // against the ledger: the tree root the transcript was proven against
        // has been superseded. That is recoverable — re-snapshot and re-prove.
        if (terminal === 'FailFallible' && attempt < MAX_ATTEST_ATTEMPTS) {
          emit({ stage: 'snapshot', predicate: sp.predicate, kind: spec.kind })
          continue
        }
        throw new Error(
          `on-chain attestation for '${sp.predicate}' failed: status=${terminal}, jobId=${jobId}` +
            (terminalError ? ` (${terminalError})` : '') +
            (terminal === 'FailFallible'
              ? ` — contract state moved between proving and inclusion on all ` +
                `${MAX_ATTEST_ATTEMPTS} attempts`
              : ''),
        )
      }
      // Reached only on SucceedEntirely — the result is pushed after the loop.
      break
    }
    if (attestSkipped) continue
    if (attestSettled) continue

    emit({ stage: 'attested', predicate: sp.predicate, kind: spec.kind })
    results.push({ predicate: sp.predicate, threshold, alreadyOnChain: false })
  }
  return results
}

/** Pull the numeric witness value the Compact circuit asserts
 *  `>= threshold` on. Used as a pre-flight check so an unsatisfiable
 *  stamped predicate doesn't kill the whole presentation. */
function numericWitnessValue(kind: PredicateKind, w: PredicateWitness): number | undefined {
  switch (kind) {
    case 'age':
    case 'age_range': {
      if (w.dobValue === undefined) return undefined
      const now = new Date()
      const today = now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate()
      return Math.floor((today - Number(w.dobValue)) / 10000)
    }
    case 'kyc':
      return w.kycLevel !== undefined ? Number(w.kycLevel) : undefined
    case 'email':
      return w.emailVerifiedFlag !== undefined ? Number(w.emailVerifiedFlag) : undefined
    case 'residency':
    case 'nationality':
    case 'personhood':
      // No numeric threshold — Compact asserts set-membership / nullifier shape.
      return undefined
  }
}

/** Predicate-attestation name → sidecar URL kind. Exposed so the
 *  wallet's DCQL-routing layer can pre-check that a stamped predicate
 *  maps to a deployed contract before bothering the user with consent. */
export function predicateNameToKind(predicate: string): PredicateKind | undefined {
  return PREDICATE_NAME_TO_KIND[predicate]
}
