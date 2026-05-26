/**
 * In-process transaction `ProofProvider` — no proof server.
 *
 * The sidecar's contract deploys and predicate_registry calls used to
 * POST to an HTTP proof server (docker `:6300` / the old shim). This
 * proves the same circuits in-process with the Midnight zkir WASM
 * prover (`@midnight-ntwrk/zkir-v2`, the core the wallet SDK's
 * `WasmProver` wraps), so no proof server is needed anywhere — the
 * wallet's balance/dust leg already proves in-process via the wallet
 * SDK's WASM prover.
 *
 * Per-circuit keys come from the contract's `ZKConfigProvider`; the
 * universal proving SRS (`bls_midnight_2p{k}`, size-keyed → serves any
 * circuit) is fetched and cached by the wallet SDK's default
 * key-material provider. Twin of `@owlid/sdk`'s `predicate-proving.ts`
 * `createInProcessProofProvider` (kept local so production sidecar code
 * does not reach into the SDK's internal dist).
 */

import { provingProvider as zkirProvingProvider } from '@midnight-ntwrk/zkir-v2'
import { WasmProver } from '@midnight-ntwrk/wallet-sdk-prover-client/effect'
import {
  createProofProvider,
  zkConfigToProvingKeyMaterial,
} from '@midnight-ntwrk/midnight-js-types'
import type { ProofProvider, ZKConfigProvider } from '@midnight-ntwrk/midnight-js-types'
import type { ProvingProvider } from '@midnight-ntwrk/ledger-v8'

// One SRS fetch+cache shared across every contract/circuit this process
// proves.
let sharedParamsProvider: ReturnType<typeof WasmProver.makeDefaultKeyMaterialProvider> | undefined

/**
 * A midnight-js `ProofProvider` that proves transactions in-process.
 * Drop-in for `httpClientProofProvider(url, zkConfigProvider)`.
 */
export function createInProcessProofProvider(
  zkConfigProvider: ZKConfigProvider<string>,
): ProofProvider {
  const params = (sharedParamsProvider ??= WasmProver.makeDefaultKeyMaterialProvider())
  const provingProvider = zkirProvingProvider({
    lookupKey: async (keyLocation: string) =>
      zkConfigToProvingKeyMaterial(await zkConfigProvider.get(keyLocation)),
    getParams: (k: number) => params.getParams(k),
  }) as unknown as ProvingProvider
  return createProofProvider(provingProvider)
}
