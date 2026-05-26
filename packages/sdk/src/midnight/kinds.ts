/**
 * INTERNAL — predicate kind taxonomy. Lockstepped with the sidecar
 * (`packages/midnight-sidecar/src/config.ts`) and the Rust attestation
 * key recipes (`crates/proof-system/src/attestation.rs`). One Compact
 * contract per kind under Midnight's per-extrinsic block-weight cap.
 */

export type PredicateKind =
  | 'age'
  | 'kyc'
  | 'residency'
  | 'email'
  | 'nationality'
  | 'age_range'
  | 'personhood'

export const PREDICATE_KINDS: readonly PredicateKind[] = [
  'age',
  'kyc',
  'residency',
  'email',
  'nationality',
  'age_range',
  'personhood',
]

/** Witness values bound into the per-kind predicate contract. Each kind
 *  reads exactly the field its Compact `witness` declares; the others go
 *  unused. Derived from the credential by the orchestrator — never a
 *  caller parameter. */
export interface PredicateWitness {
  /** `age` and `age_range` kinds — age in whole years, fits Uint<16>. */
  ageValue?: bigint
  /** `kyc` kind — verification level, fits Uint<8>. */
  kycLevel?: bigint
  /** `residency` kind — holder's residence country code (ISO 3166-1
   *  alpha-2, e.g. "NL"). Right-padded to 32 bytes before being fed
   *  to the `residentCountry` witness. */
  residentCountry?: string
  /** `email` kind — 0/1 (>=1 ⇒ provider-verified), fits Uint<8>. */
  emailVerifiedFlag?: bigint
  /** `nationality` kind — ISO 3166-1 alpha-2 country code. Same shape
   *  as `residentCountry`; padded to 32 bytes for `nationalityCode`. */
  nationalityCode?: string
  /** `personhood` kind — holder-bound 32-byte secret. */
  personhoodSecret?: Uint8Array
  /** `nationality` / `residency` — verifier's canonicalised allowed
   *  set (sorted, deduped, uppercase, ≤256 alpha-2 codes). The witness
   *  factory feeds this through `StateBoundedMerkleTree` to derive the
   *  holder's `MerkleTreePath<8, Bytes<32>>` for the
   *  `allowedCountryPath()` witness. */
  allowedCountrySet?: ReadonlyArray<string>
  /** `nationality` / `residency` — SHA-256 of the OID4VP verifier
   *  `client_id` (UTF-8 bytes). The Compact `verifierIdHash()` witness
   *  returns these 32 bytes; combined with the Merkle root in the
   *  circuit it produces the public-arg `setHash` so two verifiers
   *  with the same allowed-set still yield distinct on-chain keys. */
  verifierIdHash?: Uint8Array
}
