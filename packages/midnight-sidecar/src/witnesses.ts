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
