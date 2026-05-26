/**
 * Holder-side proof persistence + typed proof errors.
 *
 *   - `storage.ts`  IndexedDB proof history (per-credential receipts).
 *   - `errors.ts`   typed error parsing for native SDK proof failures.
 */

export { type StoredProof, ProofStorageManager, proofStorage } from './storage.js'
export {
  type ProofErrorCode,
  type ProofError,
  parseProofError,
  isPredicateNotSatisfied,
} from './errors.js'
