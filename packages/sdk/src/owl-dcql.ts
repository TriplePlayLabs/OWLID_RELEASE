/**
 * OwlID DCQL extension — `owl_predicate`.
 *
 * Per OID4VP 1.0 §6 closing note: "Future extensions may define
 * additional properties both at the top level and in the rest of the
 * DCQL data structure. Implementations MUST ignore any unknown
 * properties." We attach our predicate dispatch as an unknown
 * property on each credential query, leaving `claims` empty so a
 * spec-strict wallet correctly concludes "no claims requested" and
 * the OID4VP §6.4.1 disclosure obligation is trivially satisfied
 * (no claims to fail to satisfy).
 *
 * OwlID-aware wallets read `owl_predicate`, dispatch to the
 * Midnight per-kind contract attestation Set, and return an SD-JWT
 * VC presentation with zero disclosures + a KB-JWT — the verifier
 * server then validates the request by checking the on-chain
 * attestation key derived from `(credential_id, predicate, params,
 * verifier_id)`. Spec-strict (non-OwlID) wallets see an empty
 * `claims` array, return the credential with mandatory claims only,
 * and the server rejects the presentation as un-attested. This is
 * intentional: OwlID's privacy guarantee is that NO plaintext claim
 * value ever crosses the wire.
 *
 * Wire shape on each `DcqlCredentialQuery`:
 *
 *     {
 *       "id": "nationality_eu",
 *       "format": "dc+sd-jwt",
 *       "claims": [],
 *       "owl_predicate": { "kind": "nationality_in",
 *                          "countries": ["AT","BE",...] }
 *     }
 */

import type {
  DcqlCredentialQuery,
  OwlPredicate as GeneratedOwlPredicate,
} from '@owlid/verifier-client'

/** Discriminated union of every Midnight-native predicate the
 *  verifier can ask for. Mirrors the on-chain `attest{Kind}` Compact
 *  circuit set; every new circuit MUST get a new variant here AND a
 *  matching arm on the Rust `OwlPredicate` enum + wallet dispatch. */
export type OwlPredicate =
  /** `age:gte` — holder's age is ≥ threshold years. */
  | { kind: 'age_gte'; threshold: number }
  /** `age:range` — holder's age is in `[min, max]` inclusive. */
  | { kind: 'age_range'; min: number; max: number }
  /** `kyc:>=` — issuer's verification level is ≥ threshold (1=basic,
   *  2=substantial, 3=high). */
  | { kind: 'kyc_gte'; threshold: number }
  /** `nationality:in` — holder's nationality is in the verifier's
   *  ISO 3166-1 alpha-2 allowed set. Per-verifier salted on-chain. */
  | { kind: 'nationality_in'; countries: string[] }
  /** `residency:in` — holder's residence country is in the set. */
  | { kind: 'residency_in'; countries: string[] }
  /** `email:verified` — issuer attested the holder's email is verified. */
  | { kind: 'email_verified' }
  /** `personhood:unique` — holder is a unique human within
   *  `(epoch, app_id)`. Verifier supplies both as 32-byte hex. */
  | { kind: 'unique_personhood'; epoch: string; appId: string }

/** Build a spec-conformant `DcqlCredentialQuery` carrying an
 *  `owl_predicate` extension. `claims: []` is the spec-strict signal
 *  that no plaintext disclosure is required.
 *
 *  The TS property is `owlPredicate` (camelCase) per the generated
 *  client's `modelPropertyNaming=camelCase`; serialized to the wire as
 *  `owl_predicate` by `DcqlCredentialQueryToJSON`. The Rust side
 *  reads `owl_predicate` (snake_case) — no manual rename plumbing
 *  needed. */
export function owlCredentialQuery(id: string, predicate: OwlPredicate): DcqlCredentialQuery {
  return {
    id,
    format: 'dc+sd-jwt',
    claims: [],
    // Cast: the generated `OwlPredicate` is a union of `OneOf{0..6}`
    // per-variant types each with its own narrow `kind` enum. Our
    // hand-typed discriminated union has the same structural shape
    // and wider literal types; the runtime JSON is identical.
    owlPredicate: predicate as unknown as GeneratedOwlPredicate,
  }
}

/** Read the `owl_predicate` extension off a credential query.
 *  Returns `undefined` for spec-strict queries with no extension —
 *  caller can fall through to standard DCQL claim handling. */
export function readOwlPredicate(query: DcqlCredentialQuery): OwlPredicate | undefined {
  return (query.owlPredicate as unknown as OwlPredicate | null | undefined) ?? undefined
}

/** Strict accessor — throws when the extension is absent. Used in
 *  paths where the wallet has already filtered to OwlID-aware queries. */
export function expectOwlPredicate(query: DcqlCredentialQuery): OwlPredicate {
  const ext = readOwlPredicate(query)
  if (!ext) {
    throw new Error(
      `DCQL credential query "${query.id}" is missing the OwlID predicate ` +
        `extension (owl_predicate). OwlID does not disclose plaintext claims; ` +
        `the verifier MUST attach an owl_predicate to every credential query.`,
    )
  }
  return ext
}
