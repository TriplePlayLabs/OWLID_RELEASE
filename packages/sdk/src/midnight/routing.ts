/**
 * DCQL claim path → Midnight predicate attestation router.
 *
 * Mirror of `crates/proof-system/src/predicate_routing.rs`. Keep both
 * tables in lockstep: every entry here MUST have a matching entry on
 * the Rust side or the wallet will offer a credential the server will
 * then reject as unattested.
 *
 * Under the all-Midnight policy this is the ONLY way claims get
 * checked — there is no SD-JWT VC selective-disclosure fallback.
 */

export type RoutedPredicate =
  | { kind: 'age_gte'; threshold: number }
  | { kind: 'age_range'; minAge: number; maxAge: number }
  | { kind: 'kyc_gte'; threshold: number }
  /** Verifier-supplied allowed-set membership (≤64 ISO 3166-1 alpha-2
   *  codes — mirrors the Compact `Vector<64, Bytes<32>>` witness). The
   *  on-chain attestation key binds to a per-verifier hash of the
   *  canonical set (see `attestation::allowed_country_set_hash`), so
   *  attestations cannot replay across policies or verifiers. */
  | { kind: 'nationality_in'; countries: string[] }
  /** Same shape as `nationality_in`, but for the holder's residence
   *  country instead of nationality. */
  | { kind: 'residency_in'; countries: string[] }
  | { kind: 'email_verified' }
  | { kind: 'unique_personhood'; epoch: string; appId: string }

import { EU_COUNTRIES } from '../countries.js'

export function routeClaim(path: string, values: unknown[]): RoutedPredicate | null {
  switch (path) {
    case 'age_over':
      return pickAgeThreshold(values)
    case 'age_range':
      return pickAgeRange(values)
    case 'nationality_in': {
      const countries = pickCountrySet(values)
      return countries ? { kind: 'nationality_in', countries } : null
    }
    case 'resident_in': {
      const countries = pickCountrySet(values)
      return countries ? { kind: 'residency_in', countries } : null
    }
    // Legacy synonym kept for older verifier configs — translates to
    // the EU-27 country set.
    case 'nationality_eu':
      return { kind: 'nationality_in', countries: [...EU_COUNTRIES] }
    case 'email_verified':
      return { kind: 'email_verified' }
    case 'verification_level':
      return { kind: 'kyc_gte', threshold: pickKycThreshold(values) }
    case 'unique_person':
      return pickPersonhoodScope(values)
    default:
      return null
  }
}

/**
 * `unique_person` carries its `(epoch, app_id)` scope in the DCQL
 * `values` array as one object `{ epoch, app_id }` (32-byte hex each).
 * Without a well-formed scope the verifier did not actually request a
 * scoped personhood proof, so the claim does not route.
 *
 * Mirror of `pick_personhood_scope` in `predicate_routing.rs`.
 */
function pickPersonhoodScope(values: unknown[]): RoutedPredicate | null {
  const v = values[0]
  if (typeof v !== 'object' || v === null) return null
  const { epoch, app_id: appId } = v as { epoch?: unknown; app_id?: unknown }
  if (typeof epoch !== 'string' || typeof appId !== 'string') return null
  return { kind: 'unique_personhood', epoch, appId }
}

/**
 * `age_over` carries its threshold in the DCQL `values` array as a
 * single JSON number. The verifier supplies it at request time; a
 * missing/malformed value means the claim does not route.
 *
 * Mirror of `pick_age_threshold` in `predicate_routing.rs`.
 */
function pickAgeThreshold(values: unknown[]): RoutedPredicate | null {
  const v = values[0]
  if (typeof v !== 'number') return null
  return { kind: 'age_gte', threshold: v }
}

/**
 * `age_range` carries its inclusive bounds in the DCQL `values` array
 * as one object `{ min, max }`. The verifier supplies them at request
 * time; malformed bounds mean the claim does not route.
 *
 * Mirror of `pick_age_range` in `predicate_routing.rs`.
 */
function pickAgeRange(values: unknown[]): RoutedPredicate | null {
  const v = values[0]
  if (typeof v !== 'object' || v === null) return null
  const { min, max } = v as { min?: unknown; max?: unknown }
  if (typeof min !== 'number' || typeof max !== 'number') return null
  return { kind: 'age_range', minAge: min, maxAge: max }
}

function pickKycThreshold(values: unknown[]): number {
  for (const v of values) {
    if (typeof v === 'number') return v
    if (typeof v === 'string') {
      if (v === 'high') return 3
      if (v === 'substantial') return 2
      if (v === 'basic') return 1
    }
  }
  return 1
}

/**
 * `nationality_in` / `resident_in` carry the verifier's allowed-set in
 * DCQL `values`. Accepts three shapes — the verifier-app actually
 * emits the nested-array form, but the others stay supported because
 * older verifier configs use them:
 *   - `[["NL","BE"]]`              — nested array (verifier-app default)
 *   - `["NL","BE"]`                — flat array
 *   - `[{"countries":["NL","BE"]}]` — object with `countries` key
 * Returns `null` when malformed — the claim does not route.
 *
 * Mirror of `pick_country_set` in `predicate_routing.rs`.
 */
function pickCountrySet(values: unknown[]): string[] | null {
  if (values.length === 0) return null
  const first = values[0]
  // Form 1: nested array — the verifier-app's PredicateSelector
  // emits `claim.values = [input.countries]`, so the first slot is
  // the country array itself.
  if (Array.isArray(first)) {
    return collectCountryCodes(first as unknown[])
  }
  // Form 3: object with `countries` key.
  if (
    first !== null &&
    typeof first === 'object' &&
    Array.isArray((first as { countries?: unknown }).countries)
  ) {
    return collectCountryCodes((first as { countries: unknown[] }).countries)
  }
  // Form 2: flat array of strings.
  return collectCountryCodes(values)
}

function collectCountryCodes(arr: unknown[]): string[] | null {
  const codes: string[] = []
  for (const v of arr) {
    if (typeof v !== 'string') continue
    const upper = v.toUpperCase()
    if (upper.length === 2 && /^[A-Z]{2}$/.test(upper)) {
      codes.push(upper)
    }
  }
  if (codes.length === 0 || codes.length > MAX_COUNTRIES_PER_SET) return null
  return codes
}

/** Hard cap on the verifier-supplied allowed-set, mirroring the Compact
 *  `Vector<64, Bytes<32>>` witness. Verifier UIs MUST refuse to send a
 *  larger set; the wallet enforces it at routing time too so a buggy /
 *  malicious verifier can't blow past the contract limit. */
export const MAX_COUNTRIES_PER_SET = 64

/**
 * `owl_attestation` claim shape on the issued SD-JWT VC. The issuer
 * lists every Midnight predicate it attested for this credential at
 * issuance time. The wallet uses this list to know which DCQL queries
 * a given credential can satisfy WITHOUT consulting the chain or
 * disclosing any claim values.
 *
 * `country` is set for `nationality` and `residency` refs — the
 * holder's actual ISO 3166-1 alpha-2 code that the verifier-supplied
 * allowed-set must contain.
 */
export interface OwlAttestationRef {
  predicate: string
  threshold?: number
  min_age?: number
  max_age?: number
  epoch?: string
  app_id?: string
  country?: string
}

/** True iff `refs` contains an entry that matches `routed`. */
export function attestationCovers(refs: OwlAttestationRef[], routed: RoutedPredicate): boolean {
  return refs.some((r) => {
    switch (routed.kind) {
      case 'age_gte':
        // The issuer presence-stamps `age` with no threshold — the
        // threshold is presentation-time, supplied by the verifier's
        // DCQL, so coverage is by predicate name only.
        return r.predicate === 'age'
      case 'age_range':
        // Presence-stamped with no bounds — bounds are presentation-time.
        return r.predicate === 'age_range'
      case 'kyc_gte':
        return r.predicate === 'kyc' && r.threshold === routed.threshold
      case 'nationality_in':
        // Holder's stamped country must be in the verifier-supplied set.
        return (
          r.predicate === 'nationality' &&
          typeof r.country === 'string' &&
          routed.countries.includes(r.country.toUpperCase())
        )
      case 'residency_in':
        return (
          r.predicate === 'residency' &&
          typeof r.country === 'string' &&
          routed.countries.includes(r.country.toUpperCase())
        )
      case 'email_verified':
        return r.predicate === 'email_verified'
      case 'unique_personhood':
        // The issuer stamps `unique_personhood` with no scope — scope
        // (epoch, app_id) is presentation-time, supplied by the
        // verifier's campaign DCQL, so coverage is by predicate name.
        return r.predicate === 'unique_personhood'
    }
  })
}
