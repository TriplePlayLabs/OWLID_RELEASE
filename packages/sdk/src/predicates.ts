/**
 * Declarative predicate requests — the verifier's ergonomic surface.
 *
 * Instead of hand-writing DCQL claim paths and `values` arrays,
 * verifier code builds a list of `PredicateRequest` values via the
 * `Predicates` factory and hands them to `OwlVerifier`. The SDK
 * compiles them down to the on-wire DCQL shape that the holder app
 * solves and the verification-service re-checks.
 *
 *     await verifier.requestPredicates({
 *       verifierName: 'Acme Bar',
 *       predicates: [
 *         Predicates.ageOver(18),
 *         Predicates.residencyIn(['NL', 'BE', 'DE']),
 *         Predicates.kycLevel('substantial'),
 *       ],
 *       onQr: (qr) => render(qr),
 *     })
 *
 * No Midnight / Compact / Merkle / setHash details escape this layer —
 * verifiers describe what they want; OwlID handles the cryptography.
 */
import type { DcqlRequest } from '@owlid/verifier-client'

/** Verifier-supplied predicate the holder must satisfy. */
export type PredicateRequest =
  /** `holder_age >= threshold`. Witness on device; chain sees a hash. */
  | { kind: 'ageOver'; threshold: number }
  /** `min <= holder_age <= max`. */
  | { kind: 'ageRange'; min: number; max: number }
  /** eIDAS-style identity-verification tier. The SDK maps `basic` → 1,
   *  `substantial` → 2, `high` → 3 and forwards the numeric rung in
   *  DCQL. Numeric input is allowed for forward compatibility. */
  | { kind: 'kycLevel'; level: 'basic' | 'substantial' | 'high' | number }
  /** Holder's residence country is one of `countries`. ISO 3166-1
   *  alpha-2 codes; the SDK canonicalises (sort + dedupe + uppercase)
   *  before hashing so request ordering does not matter. */
  | { kind: 'residencyIn'; countries: string[] }
  /** Same shape as `residencyIn` but for the holder's nationality. */
  | { kind: 'nationalityIn'; countries: string[] }
  /** Issuer-attested email-verified flag is true. */
  | { kind: 'emailVerified' }
  /** Sybil-resistant unique personhood. `epoch` is the verifier's 32-byte
   *  hex campaign-period scope; `appId` is the 32-byte hex campaign/app id
   *  (e.g. a specific conference). The same human yields the same nullifier
   *  within one `(epoch, appId)` so they can register only once. `appId`
   *  is bound under the verifier's authenticated `client_id` downstream
   *  (F-2), so a different verifier choosing the same `appId` string lands
   *  in a different namespace and cannot correlate attendees. */
  | { kind: 'uniquePerson'; epoch: string; appId: string }

/** Fluent factory — saves callers from writing the discriminant by
 *  hand and gives a stable rename anchor. */
export const Predicates = {
  ageOver(threshold: number): PredicateRequest {
    return { kind: 'ageOver', threshold }
  },
  ageRange(min: number, max: number): PredicateRequest {
    return { kind: 'ageRange', min, max }
  },
  kycLevel(level: 'basic' | 'substantial' | 'high' | number): PredicateRequest {
    return { kind: 'kycLevel', level }
  },
  residencyIn(countries: string[]): PredicateRequest {
    return { kind: 'residencyIn', countries }
  },
  nationalityIn(countries: string[]): PredicateRequest {
    return { kind: 'nationalityIn', countries }
  },
  emailVerified(): PredicateRequest {
    return { kind: 'emailVerified' }
  },
  uniquePerson(opts: { epoch: string; appId: string }): PredicateRequest {
    return { kind: 'uniquePerson', epoch: opts.epoch, appId: opts.appId }
  },
} as const

/** Lower a `PredicateRequest` to its DCQL claim representation. The
 *  `path` + `values` shape is what `crates/proof-system/src/
 *  predicate_routing.rs` matches on the verifier side and what
 *  `packages/sdk/src/midnight/routing.ts` matches on the wallet side. */
function toDcqlClaim(p: PredicateRequest): { path: string[]; values: unknown[] } {
  switch (p.kind) {
    case 'ageOver':
      return { path: ['age_over'], values: [p.threshold] }
    case 'ageRange':
      return { path: ['age_range'], values: [{ min: p.min, max: p.max }] }
    case 'kycLevel':
      return { path: ['verification_level'], values: [p.level] }
    case 'residencyIn':
      return { path: ['resident_in'], values: [p.countries] }
    case 'nationalityIn':
      return { path: ['nationality_in'], values: [p.countries] }
    case 'emailVerified':
      return { path: ['email_verified'], values: [true] }
    case 'uniquePerson':
      return {
        path: ['unique_person'],
        values: [{ epoch: p.epoch, app_id: p.appId }],
      }
  }
}

/** Single OwlID credential format on the wire. Surfaced as a constant
 *  so callers don't sprinkle it through their code. */
export const OWL_DCQL_FORMAT = 'dc+sd-jwt' as const

/** Compile a list of declarative predicates into a single-credential
 *  DCQL request. Used by `OwlVerifier.requestPredicates` and exposed
 *  publicly so callers who want the raw DCQL (e.g. to feed an external
 *  wallet via `request_uri`) can build it without hand-rolling JSON. */
export function buildDcqlRequest(predicates: PredicateRequest[]): DcqlRequest {
  if (predicates.length === 0) {
    throw new Error('buildDcqlRequest: at least one predicate is required')
  }
  return {
    credentials: [
      {
        id: 'cred0',
        format: OWL_DCQL_FORMAT,
        claims: predicates.map(toDcqlClaim),
      },
    ],
  }
}
