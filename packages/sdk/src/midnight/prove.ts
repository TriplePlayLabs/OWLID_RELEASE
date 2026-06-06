/**
 * INTERNAL — `@owlid/sdk/midnight/prove` — the holder's prove-without-submit step.
 *
 * Ties the off-chain snapshot, an in-process WASM prover, and
 * midnight-js's staged call API into one call: the holder runs
 * circuit-exec (consuming the private witness) + proving locally and
 * returns a proven, UNSUBMITTED transaction. It never balances, submits,
 * or touches the chain — the backend relay does that.
 *
 * The caller supplies the predicate contract already compiled **with the
 * holder's witness bound** (the witness value is the caller's secret;
 * keeping it out of this module's signature keeps the SDK asset-free and
 * the witness on the caller's side).
 */

import { createCallTxOptions, createUnprovenCallTx } from '@midnight-ntwrk/midnight-js-contracts'
import type { ZKConfigProvider } from '@midnight-ntwrk/midnight-js-types'
import {
  createProofProviderFor,
  resolveProvingConfig,
  type ProvingProviderConfig,
} from './prover.js'
import { createSnapshotPublicDataProvider, type PredicateSnapshot } from './snapshot.js'
import { ensureMidnightNetworkConfigured } from './network.js'

/** Minimal in-memory private-state provider. Per-kind predicate
 *  witnesses pass `privateState` through untouched (PS = `{}`), so no
 *  IndexedDB/LevelDB store is needed on the holder device. */
function inMemoryPrivateStateProvider(initial: unknown = {}) {
  const store = new Map<string, unknown>()
  return {
    _contractAddress: undefined as string | undefined,
    setContractAddress(addr: string) {
      this._contractAddress = addr
    },
    async get(id: string) {
      return store.has(id) ? store.get(id) : initial
    },
    async set(id: string, ps: unknown) {
      store.set(id, ps)
    },
    async remove(id: string) {
      store.delete(id)
    },
    async clear() {
      store.clear()
    },
  }
}

/** Holder stub wallet: zero keys, and balancing/submitting is a hard
 *  error. Proves at the type+runtime level that the holder cannot reach
 *  the chain even by mistake. */
const offChainStubWallet = {
  getCoinPublicKey: () => '00'.repeat(32),
  getEncryptionPublicKey: () => '00'.repeat(32),
  balanceTx: () => {
    throw new Error('holder must not balance/submit (hidden-chain rule)')
  },
}

export interface ProveAttestationParams {
  /** predicate contract compiled WITH the holder's witness bound
   *  (`CompiledContract.make(...).pipe(withWitnesses(...), withCompiledFileAssets(...))`). */
  compiledContract: Parameters<typeof createCallTxOptions>[0]
  /** Resolves zkir + proving/verifier keys for the predicate circuits. */
  zkConfigProvider: ZKConfigProvider<string>
  /** Backend-supplied off-chain state snapshot. */
  snapshot: PredicateSnapshot
  /** Kind-specific attest circuit name (`attestAgeGte` | `attestKycGte`
   *  | `attestResidency` | `attestEmailVerified` | `attestNationalityIn`
   *  | `attestAgeRange` | `attestUniquePersonhood`). */
  circuitId: string
  /** Public circuit args — kind-specific. Examples: `[rootHash, threshold]`
   *  for `age`/`kyc`, `[rootHash]` for `residency`/`email`/`nationality`,
   *  `[rootHash, minAge, maxAge]` for `age_range`,
   *  `[rootHash, epoch, appId]` for `personhood`. The private witness is
   *  bound in `compiledContract`, never here. */
  args: unknown[]
  /** Private-state id the contract was deployed under — distinct per
   *  predicate kind under the per-extrinsic split. The orchestrator
   *  passes `owlid-predicate-<kind>`; callers staying on the default
   *  match the historical single-contract id. */
  privateStateId?: string
  /** Optional proof-provider selection. Defaults to the global
   *  `@owlid/config` `provingMode` (`wasm` unless the holder opted into
   *  a remote proof server). Pass to force a specific backend in tests. */
  proofProvider?: ProvingProviderConfig
}

/**
 * Holder-device step: circuit-exec (witness consumed here) + in-process
 * ZK proof. Returns the serialized proven, unsubmitted
 * `UnboundTransaction` — POST these bytes to the backend relay, which
 * balances + submits. The witness is gone from these bytes (preimage →
 * ZK proof); only the proof crosses the device boundary.
 */
export async function proveAttestationUnsubmitted(
  params: ProveAttestationParams,
): Promise<Uint8Array> {
  const {
    compiledContract,
    zkConfigProvider,
    snapshot,
    circuitId,
    args,
    privateStateId = 'owlid-predicate',
    proofProvider: provingConfig,
  } = params

  // midnight-js reads the network id from a process-global slot; without
  // it `createUnprovenCallTx` aborts with "Network ID has not been
  // configured". The SDK fetches the operator-published value from
  // `GET /midnight/info` once per process and calls `setNetworkId()`.
  await ensureMidnightNetworkConfigured()

  const publicDataProvider = createSnapshotPublicDataProvider(snapshot)
  const privateStateProvider = inMemoryPrivateStateProvider({})
  const proofProvider = await createProofProviderFor(
    zkConfigProvider,
    resolveProvingConfig(provingConfig),
  )

  // Mirror what findDeployedContract/submitCallTx do before
  // createUnprovenCallTx (the scoped private-state lookup needs it).
  privateStateProvider.setContractAddress(snapshot.address)

  const opts = (createCallTxOptions as (...a: unknown[]) => unknown)(
    compiledContract,
    circuitId,
    snapshot.address,
    privateStateId,
    undefined,
    args,
  )
  const unsub = (await (createUnprovenCallTx as (...a: unknown[]) => Promise<unknown>)(
    {
      zkConfigProvider,
      publicDataProvider,
      privateStateProvider,
      walletProvider: offChainStubWallet,
    },
    opts,
  )) as { private: { unprovenTx: { serialize(): Uint8Array } } }

  const unbound = await proofProvider.proveTx(unsub.private.unprovenTx as never)
  return unbound.serialize()
}
