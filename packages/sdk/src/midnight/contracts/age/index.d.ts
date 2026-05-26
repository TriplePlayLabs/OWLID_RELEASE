import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type ZswapCoinPublicKey = { bytes: Uint8Array };

export type ContractAddress = { bytes: Uint8Array };

export type Either<A, B> = { is_left: boolean; left: A; right: B };

export type Maybe<T> = { is_some: boolean; value: T };

export type Witnesses<PS> = {
  ageValue(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, bigint];
}

export type ImpureCircuits<PS> = {
  attestAgeGte(context: __compactRuntime.CircuitContext<PS>,
               rootHash_0: Uint8Array,
               threshold_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  isAttested(context: __compactRuntime.CircuitContext<PS>, key_0: Uint8Array): __compactRuntime.CircuitResults<PS, boolean>;
  pause(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  unpause(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  transferOwnership(context: __compactRuntime.CircuitContext<PS>,
                    newOwner_0: Either<ZswapCoinPublicKey, ContractAddress>): __compactRuntime.CircuitResults<PS, []>;
  owner(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, Either<ZswapCoinPublicKey,
                                                                                                  ContractAddress>>;
  isPaused(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, boolean>;
}

export type ProvableCircuits<PS> = {
  attestAgeGte(context: __compactRuntime.CircuitContext<PS>,
               rootHash_0: Uint8Array,
               threshold_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  isAttested(context: __compactRuntime.CircuitContext<PS>, key_0: Uint8Array): __compactRuntime.CircuitResults<PS, boolean>;
  pause(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  unpause(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  transferOwnership(context: __compactRuntime.CircuitContext<PS>,
                    newOwner_0: Either<ZswapCoinPublicKey, ContractAddress>): __compactRuntime.CircuitResults<PS, []>;
  owner(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, Either<ZswapCoinPublicKey,
                                                                                                  ContractAddress>>;
  isPaused(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, boolean>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  attestAgeGte(context: __compactRuntime.CircuitContext<PS>,
               rootHash_0: Uint8Array,
               threshold_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  isAttested(context: __compactRuntime.CircuitContext<PS>, key_0: Uint8Array): __compactRuntime.CircuitResults<PS, boolean>;
  pause(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  unpause(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  transferOwnership(context: __compactRuntime.CircuitContext<PS>,
                    newOwner_0: Either<ZswapCoinPublicKey, ContractAddress>): __compactRuntime.CircuitResults<PS, []>;
  owner(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, Either<ZswapCoinPublicKey,
                                                                                                  ContractAddress>>;
  isPaused(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, boolean>;
}

export type Ledger = {
  attestations: {
    isEmpty(): boolean;
    size(): bigint;
    member(elem_0: Uint8Array): boolean;
    [Symbol.iterator](): Iterator<Uint8Array>
  };
  attestTree: {
    isFull(): boolean;
    checkRoot(rt_0: { field: bigint }): boolean;
    root(): __compactRuntime.MerkleTreeDigest;
    firstFree(): bigint;
    pathForLeaf(index_0: bigint, leaf_0: Uint8Array): __compactRuntime.MerkleTreePath<Uint8Array>;
    findPathForLeaf(leaf_0: Uint8Array): __compactRuntime.MerkleTreePath<Uint8Array> | undefined;
    history(): Iterator<__compactRuntime.MerkleTreeDigest>
  };
  readonly attestCount: bigint;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>,
               initialOwner_0: Either<ZswapCoinPublicKey, ContractAddress>): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
