/**
 * @owlid/sdk/midnight — advanced Midnight predicate-proving surface.
 *
 * Curated export bundle for callers who run their own predicate relay
 * (the OwlID sidecar, or a third-party deployment hosting the
 * Midnight-side proof relay). The top-level `@owlid/sdk` barrel stays
 * free of Midnight-specific types so application code (verifier dApps,
 * holder wallets) only sees `OwlVerifier` / `OwlWallet` / `Predicates`.
 *
 * Reach for this subpath when you need to:
 *   - build the verifier-supplied allowed-set Merkle tree yourself
 *     (`buildAllowedSetTree`, `findPathForCountry`, `treeRootBytesLE`)
 *   - prove an attestation circuit off-device
 *     (`proveAttestationUnsubmitted`, `createInProcessProofProvider`)
 *   - re-derive on-chain attestation keys
 *     (`ageKey`, `kycKey`, `nationalityKey`, …)
 *   - hand-build a `PredicateSnapshot` payload for offline circuit-exec
 *
 *     import {
 *       buildAllowedSetTree,
 *       findPathForCountry,
 *       proveAttestationUnsubmitted,
 *       nationalityKey,
 *     } from '@owlid/sdk/midnight'
 *
 * Everything re-exported here is stable across SDK minor versions but
 * carries a steeper learning curve than the main barrel — you need
 * working knowledge of Midnight's witness/disclose model + the
 * predicate routing table to use it correctly.
 */

// Off-chain allowed-set Merkle helpers — verifier + holder both build
// the same tree so the on-chain setHash is deterministic across
// language mirrors (Rust verification-service + TS wallet + TS sidecar).
export {
  buildAllowedSetTree,
  findPathForCountry,
  treeRootBytesLE,
  canonicaliseCountries,
  MERKLE_DEPTH,
  COUNTRY_SET_SLOTS,
} from './merkle.js'

// On-chain attestation key recipes (TS port of
// `crates/proof-system/src/attestation.rs`). Recompute the key the
// verification-service uses to look up an attestation on the
// SSE-mirrored set without round-tripping `/predicates/attested`.
export {
  ageKey,
  kycKey,
  ageRangeKey,
  emailVerifiedKey,
  uniquePersonhoodKey,
  nationalityKey,
  residencyKey,
  allowedCountrySetHash,
  verifierIdHash,
  keyHex,
  TAG_AGE,
  TAG_KYC,
  TAG_NATIONALITY,
  TAG_RESIDENCY,
  TAG_AGE_RANGE,
  TAG_EMAIL_VERIFIED,
  TAG_UNIQUE_PERSONHOOD,
} from './attestation-keys.js'

// Holder-side proving + transport primitives. The OwlID sidecar
// stitches `proveAttestationUnsubmitted` together with its chain
// wallet to balance + submit attestation transactions on behalf of
// the holder; third-party relays can do the same.
export { proveAttestationUnsubmitted, type ProveAttestationParams } from './prove.js'
export {
  createInProcessProofProvider,
  createInProcessProvingProvider,
  createProofProviderFor,
  resolveProvingConfig,
  type ProvingProviderConfig,
} from './prover.js'
export {
  encodePredicateSnapshot,
  createSnapshotPublicDataProvider,
  HolderOffChainError,
  type PredicateSnapshot,
} from './snapshot.js'
export { ensureMidnightNetworkConfigured } from './network.js'

// Witness padding helper — the predicate circuits accept right-padded
// alpha-2 country codes as their `residentCountry` / `nationalityCode`
// witnesses.
export { padCountry } from './witnesses.js'

// Wire types the witness factories produce. Sidecar / third-party
// relays type their witness pending state against these without
// pulling `@midnight-ntwrk/compact-runtime` into their public API.
export type {
  MerkleTreePath,
  MerkleTreePathEntry,
  MerkleTreeDigest,
} from '@midnight-ntwrk/compact-runtime'

// Wallet-side DCQL routing + attestation-coverage check. Surfaced
// here so a third-party holder app can pre-flight a DCQL query
// without depending on the OwlWallet class.
export {
  routeClaim,
  attestationCovers,
  type RoutedPredicate,
  type OwlAttestationRef,
} from './routing.js'
