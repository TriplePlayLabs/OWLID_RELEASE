/**
 * OwlID Witness Implementations
 *
 * Witness functions are declared in Compact contracts but implemented in TypeScript.
 * They run locally on the user's machine and provide private data to circuits
 * without exposing it to the blockchain.
 *
 * The generated contract types (in managed/) define the witness signatures:
 * - Witnesses<PS> = { ownerSecretKey(context: WitnessContext<Ledger, PS>): [PS, Uint8Array] }
 */

import type { WitnessContext } from '@midnight-ntwrk/compact-runtime'
import type { MerkleTreePath } from '@owlid/sdk/midnight'
import type { Ledger as RevocationLedger } from '../managed/revocation_registry/contract/index.js'
// Predicate ledger type is per-contract (one contract per predicate),
// and the witness callbacks don't read ledger state — so we treat
// the ledger generic as `unknown` here. Each per-predicate contract
// supplies the actual ledger shape at its own callsite.
type PredicateLedger = unknown

/**
 * Private state for the identity registry contract.
 * Stored locally on the user's device via levelPrivateStateProvider.
 */
export interface IdentityPrivateState {
  /** The user's secret key for DID ownership proofs (32 bytes) */
  secretKey: Uint8Array
}

/**
 * Witness type matching the generated Compact contract declaration.
 * This mirrors the Witnesses<PS> type from managed/identity_registry/contract/index.d.ts
 * so we don't need a build-time dependency on generated code.
 */
export interface IdentityRegistryWitnesses<PS> {
  ownerSecretKey(context: WitnessContext<unknown, PS>): [PS, Uint8Array]
}

/**
 * Create witness implementations for the IdentityRegistry contract.
 *
 * The `ownerSecretKey` witness provides the user's secret key for
 * DID ownership proofs. This key NEVER leaves the user's machine -
 * only a hash derived from it is stored on-chain.
 *
 * @param secretKey - The user's 32-byte secret key
 * @returns Witness implementations matching the Compact contract declaration
 */
export function createIdentityRegistryWitnesses(
  secretKey: Uint8Array,
): IdentityRegistryWitnesses<IdentityPrivateState> {
  return {
    ownerSecretKey: (context) => {
      return [context.privateState, secretKey]
    },
  }
}

/**
 * Create witness implementations from stored private state.
 * Used when restoring a session from levelPrivateStateProvider.
 */
export function createWitnessesFromPrivateState(): IdentityRegistryWitnesses<IdentityPrivateState> {
  return {
    ownerSecretKey: (context) => {
      const sk = context.privateState.secretKey
      if (!sk || sk.length !== 32) {
        throw new Error('Owner secret key not found in private state')
      }
      return [context.privateState, sk]
    },
  }
}

/**
 * Witness type for the RevocationRegistry contract — declares
 * `revocationPath(rootHash)` which is consumed by the
 * `proveRevocationInclusion` circuit. Mirrors the
 * `Witnesses<PS>` type from
 * managed/revocation_registry/contract/index.d.ts so we don't need
 * a build-time dependency on generated code beyond the Ledger type.
 */
export interface RevocationRegistryWitnesses<PS> {
  revocationPath(
    context: WitnessContext<RevocationLedger, PS>,
    rootHash: Uint8Array,
  ): [PS, MerkleTreePath<Uint8Array>]
}

// Real RevocationRegistry witness. Reads the live `revokedTree`
// HistoricMerkleTree from ledger state and derives the Merkle path
// for `rootHash`. Throws if the rootHash has never been revoked
// (caller is attempting to prove inclusion of an absent leaf).
export function createRevocationRegistryWitnesses<PS>(): RevocationRegistryWitnesses<PS> {
  return {
    revocationPath: (context, rootHash) => {
      const path = context.ledger.revokedTree.findPathForLeaf(rootHash)
      if (!path) {
        const hex = Buffer.from(rootHash).toString('hex')
        throw new Error(`revocationPath: rootHash ${hex} not present in revokedTree`)
      }
      return [context.privateState, path]
    },
  }
}

/**
 * Per-kind predicate witnesses (age / kyc / residency / email /
 * nationality / age_range / personhood).
 *
 * Values are request-scoped private inputs. The sidecar sets
 * `pending` immediately before invoking a single attest circuit (calls
 * are serialized by a mutex in MidnightClient), and the witness
 * callbacks read it. `residentCountry` and `nationalityCode` are
 * 32-byte right-padded ISO 3166-1 alpha-2 codes — the Compact
 * `attest{Residency,Nationality}In(rootHash, allowedCountries)`
 * circuits check membership of the witness in the verifier-supplied
 * public set, so the country itself stays off the chain (only the
 * set the verifier asked about is disclosed).
 */
export interface PredicatePending {
  age?: bigint
  kycLevel?: bigint
  /** 32-byte right-padded ISO-3166-1 alpha-2 country code. */
  residentCountry?: Uint8Array
  /** 32-byte right-padded ISO-3166-1 alpha-2 country code. */
  nationalityCode?: Uint8Array
  emailVerified?: bigint
  /** Holder-bound personhood secret (32 bytes), supplied per-request. */
  personhoodSecret?: Uint8Array
  /** Verifier-supplied Merkle path for `nationality_in` / `resident_in`
   *  proving the holder's country is in the verifier's allowed-set
   *  tree. Depth-8 path (256-leaf tree) built off-chain from the
   *  canonical (sorted+deduped+uppercased+zero-padded) country list.
   *  The compact `allowedCountryPath()` witness returns this. */
  allowedCountryPath?: MerkleTreePath<Uint8Array>
  /** SHA-256 of the OID4VP verifier `client_id` UTF-8 bytes. The
   *  Compact `verifierIdHash()` witness returns these 32 bytes; the
   *  circuit folds them into the public-arg `setHash` so two verifiers
   *  asking the same allowed-set still produce distinct on-chain keys. */
  verifierIdHash?: Uint8Array
}

export interface PredicateRegistryWitnesses<PS> {
  ageValue(context: WitnessContext<PredicateLedger, PS>): [PS, bigint]
  kycLevel(context: WitnessContext<PredicateLedger, PS>): [PS, bigint]
  residentCountry(context: WitnessContext<PredicateLedger, PS>): [PS, Uint8Array]
  nationalityCode(context: WitnessContext<PredicateLedger, PS>): [PS, Uint8Array]
  emailVerifiedFlag(context: WitnessContext<PredicateLedger, PS>): [PS, bigint]
  personhoodSecret(context: WitnessContext<PredicateLedger, PS>): [PS, Uint8Array]
  allowedCountryPath(context: WitnessContext<PredicateLedger, PS>): [PS, MerkleTreePath<Uint8Array>]
  verifierIdHash(context: WitnessContext<PredicateLedger, PS>): [PS, Uint8Array]
}

export function createPredicateRegistryWitnesses<PS>(
  getPending: () => PredicatePending,
): PredicateRegistryWitnesses<PS> {
  return {
    ageValue: (context) => {
      const v = getPending().age
      if (v === undefined) throw new Error('ageValue witness: no pending age')
      return [context.privateState, v]
    },
    kycLevel: (context) => {
      const v = getPending().kycLevel
      if (v === undefined) throw new Error('kycLevel witness: no pending kycLevel')
      return [context.privateState, v]
    },
    residentCountry: (context) => {
      const v = getPending().residentCountry
      if (!v) throw new Error('residentCountry witness: no pending residentCountry')
      if (v.length !== 32) {
        throw new Error(`residentCountry witness: expected 32 bytes, got ${v.length}`)
      }
      return [context.privateState, v]
    },
    nationalityCode: (context) => {
      const v = getPending().nationalityCode
      if (!v) throw new Error('nationalityCode witness: no pending nationalityCode')
      if (v.length !== 32) {
        throw new Error(`nationalityCode witness: expected 32 bytes, got ${v.length}`)
      }
      return [context.privateState, v]
    },
    emailVerifiedFlag: (context) => {
      const v = getPending().emailVerified
      if (v === undefined) {
        throw new Error('emailVerifiedFlag witness: no pending emailVerified')
      }
      return [context.privateState, v]
    },
    personhoodSecret: (context) => {
      const v = getPending().personhoodSecret
      if (!v) throw new Error('personhoodSecret witness: no pending personhoodSecret')
      if (v.length !== 32) {
        throw new Error(`personhoodSecret witness: expected 32 bytes, got ${v.length}`)
      }
      return [context.privateState, v]
    },
    allowedCountryPath: (context) => {
      const v = getPending().allowedCountryPath
      if (!v) throw new Error('allowedCountryPath witness: no pending allowedCountryPath')
      return [context.privateState, v]
    },
    verifierIdHash: (context) => {
      const v = getPending().verifierIdHash
      if (!v) throw new Error('verifierIdHash witness: no pending verifierIdHash')
      if (v.length !== 32) {
        throw new Error(`verifierIdHash witness: expected 32 bytes, got ${v.length}`)
      }
      return [context.privateState, v]
    },
  }
}
