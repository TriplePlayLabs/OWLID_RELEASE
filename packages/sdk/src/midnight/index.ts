/**
 * INTERNAL barrel for the SDK's Midnight integration. Only types
 * referenced by public surfaces (the holder app's progress callback,
 * the wallet's DCQL router) leave the SDK — everything else stays
 * internal (`feedback_midnight_is_a_refactor_not_new_surface`).
 *
 * Layout under `src/midnight/`:
 *   - `network.ts`       process-global midnight-js network id init
 *   - `assets.ts`        per-kind compiled contract + zkConfig provider
 *   - `witnesses.ts`     per-kind witness derivation from holder inputs
 *   - `prove.ts`         single-kind prove-without-submit transaction
 *   - `prover.ts`        in-process zkir-v2 ProofProvider primitive
 *   - `snapshot.ts`      backend snapshot + holder-side PublicDataProvider
 *   - `orchestrator.ts`  `ensureCredentialPredicatesAttested` + transport
 *   - `routing.ts`       DCQL claim path ↔ predicate routing table
 *   - `contracts/<kind>/` vendored compactc ABI modules (7 kinds)
 */

export { ensureMidnightNetworkConfigured } from './network.js'
export {
  createPredicateAssets,
  type PredicateAssets,
  type PredicateAssetsOptions,
  type PredicateKind,
  type PredicateWitness,
  PREDICATE_KINDS,
} from './assets.js'
export { proveAttestationUnsubmitted, type ProveAttestationParams } from './prove.js'
export {
  createInProcessProofProvider,
  createInProcessProvingProvider,
  createProofProviderFor,
  resolveProvingConfig,
  type ProvingProviderConfig,
} from './prover.js'
export {
  type PredicateSnapshot,
  encodePredicateSnapshot,
  createSnapshotPublicDataProvider,
  HolderOffChainError,
} from './snapshot.js'
export {
  createPredicateTransport,
  ensureCredentialPredicatesAttested,
  predicateNameToKind,
  type AttestProgress,
  type EnsureResult,
  type PredicateTransport,
} from './orchestrator.js'
export {
  routeClaim,
  attestationCovers,
  type RoutedPredicate,
  type OwlAttestationRef,
} from './routing.js'
export {
  buildAllowedSetTree,
  findPathForCountry,
  treeRootBytesLE,
  canonicaliseCountries,
  MERKLE_DEPTH,
  COUNTRY_SET_SLOTS,
} from './merkle.js'
