/**
 * `@owlid/sdk/predicate-snapshot` — the holder's off-chain view.
 *
 * The hidden-chain rule: the holder app never talks to the indexer or
 * the node. But `createUnprovenCallTx` needs the contract's public
 * state for circuit-exec (for nationality, the `approvedNationality`
 * HistoricMerkleTree so `findPathForLeaf` runs offline). The backend
 * fetches that state once and ships a **snapshot**; the holder feeds
 * this snapshot-backed `PublicDataProvider` to `createUnprovenCallTx`.
 *
 * `createUnprovenCallTx` reads public state through exactly one method —
 * `queryZSwapAndContractState` (see midnight-js-contracts `getPublicStates`).
 * Every other `PublicDataProvider` method throws: a holder that reaches
 * for the chain is a bug, not a fallback.
 */

// ContractState MUST come from @midnight-ntwrk/compact-runtime — that is
// the class midnight-js-indexer-public-data-provider deserializes into
// and midnight-js-contracts' createUnprovenCallTx type-guards on. The
// ledger-v8 ContractState is a different wasm class and is rejected with
// "has unexpected type". ZswapChainState / LedgerParameters are ledger-v8
// (matching the indexer provider).
import { ContractState } from '@midnight-ntwrk/compact-runtime'
import { LedgerParameters, ZswapChainState } from '@midnight-ntwrk/ledger-v8'
import type { ContractAddress } from '@midnight-ntwrk/ledger-v8'
import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types'
import { bytesToHex, hexToBytes } from '../encoding.js'

/** Wire form of the backend-supplied state snapshot (all hex). */
export interface PredicateSnapshot {
  /** Contract address the snapshot was taken for (binding check). */
  address: string
  /** `ZswapChainState.serialize()` hex. */
  zswapChainState: string
  /** `ContractState.serialize()` hex — carries the predicate ledger
   *  incl. the `approvedNationality` HistoricMerkleTree. */
  contractState: string
  /** `LedgerParameters.serialize()` hex. */
  ledgerParameters: string
}

/**
 * Backend-side: encode the live `queryZSwapAndContractState` result into
 * the wire snapshot. (The sidecar relay endpoint produces this.)
 */
export function encodePredicateSnapshot(
  address: ContractAddress,
  states: [ZswapChainState, ContractState, LedgerParameters],
): PredicateSnapshot {
  const [zswap, contract, params] = states
  return {
    address,
    zswapChainState: bytesToHex(zswap.serialize()),
    contractState: bytesToHex(contract.serialize()),
    ledgerParameters: bytesToHex(params.serialize()),
  }
}

/** Thrown when holder code reaches for the chain — a bug, not a fallback. */
export class HolderOffChainError extends Error {
  constructor(method: string) {
    super(
      `PublicDataProvider.${method} is unavailable on the holder device ` +
        `(hidden-chain rule). Only queryZSwapAndContractState (from the ` +
        `backend snapshot) is permitted.`,
    )
    this.name = 'HolderOffChainError'
  }
}

/**
 * Holder-side: a `PublicDataProvider` that serves the backend snapshot
 * for `queryZSwapAndContractState` and refuses every other method. Feed
 * this to `createUnprovenCallTx`; the holder never queries the indexer.
 */
export function createSnapshotPublicDataProvider(snapshot: PredicateSnapshot): PublicDataProvider {
  const states: [ZswapChainState, ContractState, LedgerParameters] = [
    ZswapChainState.deserialize(hexToBytes(snapshot.zswapChainState)),
    ContractState.deserialize(hexToBytes(snapshot.contractState)),
    LedgerParameters.deserialize(hexToBytes(snapshot.ledgerParameters)),
  ]
  const deny = (m: string) => {
    throw new HolderOffChainError(m)
  }
  return {
    async queryZSwapAndContractState(contractAddress: ContractAddress) {
      if (contractAddress !== snapshot.address) {
        throw new Error(`snapshot is for ${snapshot.address}, not ${contractAddress}`)
      }
      return states
    },
    queryContractState: () => deny('queryContractState'),
    queryDeployContractState: () => deny('queryDeployContractState'),
    queryUnshieldedBalances: () => deny('queryUnshieldedBalances'),
    watchForContractState: () => deny('watchForContractState'),
    watchForUnshieldedBalances: () => deny('watchForUnshieldedBalances'),
    watchForDeployTxData: () => deny('watchForDeployTxData'),
    watchForTxData: () => deny('watchForTxData'),
    contractStateObservable: () => deny('contractStateObservable'),
  } as unknown as PublicDataProvider
}
