/**
 * INTERNAL — `@owlid/sdk/midnight/prover` — holder-device predicate proving.
 *
 * The holder proves a predicate circuit locally so the private witness
 * never leaves the device, and ships only a proven (unsubmitted)
 * transaction to the backend relay. The in-process prover is
 * `@midnight-ntwrk/zkir-v2` (the Midnight zkir WASM prover — the same
 * core the wallet SDK's `WasmProver` wraps); midnight-js / ledger-v8 own
 * circuit-exec and preimage serialization.
 *
 * This mirrors `httpClientProofProvider` but with an in-process
 * `ProvingProvider` instead of an HTTP proof server: same public
 * `createProofProvider(provingProvider)` seam, zero reimplementation of
 * preimage serialization, and — because zkir-v2 is ledger-v8 native —
 * no ledger version skew, so no `/check` tag reconciliation is needed.
 *
 * The universal BLS SRS (`bls_midnight_2p{k}`) is fetched via the
 * verification-service `/midnight/params/{k}` proxy (the upstream S3
 * bucket has no CORS headers, so a browser cannot fetch directly).
 * The proxy serves the same bytes with an immutable Cache-Control,
 * and an in-memory map dedupes refetches within a single page session.
 */

import { provingProvider as zkirProvingProvider } from '@midnight-ntwrk/zkir-v2'
import type { KeyMaterialProvider } from '@midnight-ntwrk/zkir-v2'
import {
  createProofProvider,
  zkConfigToProvingKeyMaterial,
} from '@midnight-ntwrk/midnight-js-types'
import type { ProofProvider, ZKConfigProvider } from '@midnight-ntwrk/midnight-js-types'
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider'
import type { ProvingProvider } from '@midnight-ntwrk/ledger-v8'
import { getMonitoringApi } from '@owlid/verifier-client'
import { getProvingMode, getProofServerUrl, type ProvingMode } from '@owlid/config'

// In-memory SRS cache shared across every predicate prove in this
// process. The browser HTTP cache covers cross-tab/cross-session reuse;
// this Map prevents re-fetching the same `k` within a single page load.
const paramsCache = new Map<number, Uint8Array>()
const paramsInflight = new Map<number, Promise<Uint8Array>>()

async function fetchParams(k: number): Promise<Uint8Array> {
  const hit = paramsCache.get(k)
  if (hit) return hit
  const existing = paramsInflight.get(k)
  if (existing) return existing
  // The route returns raw octet-stream (typed method resolves `void`);
  // read bytes off the underlying response via the `…Raw` variant.
  const p = getMonitoringApi()
    .getMidnightParamsRaw({ k })
    .then(async (res) => {
      const bytes = new Uint8Array(await res.raw.arrayBuffer())
      paramsCache.set(k, bytes)
      return bytes
    })
    .finally(() => paramsInflight.delete(k))
  paramsInflight.set(k, p)
  return p
}

/**
 * In-process circuit-level `ProvingProvider` (`check` / `prove`) backed
 * by the zkir-v2 WASM prover. The witness is consumed by
 * `createUnprovenCallTx` (holder-side) before this is ever called; this
 * only turns the unproven preimage into a ZK proof, in-process.
 *
 * @param zkConfigProvider Resolves the predicate circuit's
 *   prover/verifier keys + zkir. The universal proving parameters (SRS)
 *   come from the verification-service `/midnight/params/{k}` proxy.
 */
export function createInProcessProvingProvider(
  zkConfigProvider: ZKConfigProvider<string>,
): ProvingProvider {
  const kmp: KeyMaterialProvider = {
    lookupKey: async (keyLocation: string) =>
      zkConfigToProvingKeyMaterial(await zkConfigProvider.get(keyLocation)),
    getParams: fetchParams,
  }
  return zkirProvingProvider(kmp) as unknown as ProvingProvider
}

/**
 * Transaction-level `ProofProvider` for holder-device predicate proving.
 * Drop-in for `httpClientProofProvider` in `createUnprovenCallTx` →
 * `proofProvider.proveTx` flows. Fully in-process — no proof server.
 */
export function createInProcessProofProvider(
  zkConfigProvider: ZKConfigProvider<string>,
): ProofProvider {
  return createProofProvider(createInProcessProvingProvider(zkConfigProvider))
}

/**
 * Selection between the in-process WASM prover and a remote proof server.
 * `wasm` keeps the witness on device (default); `proof-server` POSTs the
 * unproven preimage to a hosted Midnight proof server and receives the
 * proof back. The witness has already been consumed by `createUnprovenCallTx`
 * before either provider runs, so neither sees the holder's secret.
 */
export type ProvingProviderConfig =
  | { mode: 'wasm' }
  | {
      mode: 'proof-server'
      url: string
      timeout?: number
      headers?: Record<string, string>
    }

/**
 * Build a transaction-level `ProofProvider` honouring `config`. Falls back
 * to `wasm` when `config` is omitted or shaped malformed. Public so the
 * holder app can construct one against runtime settings before calling
 * `OwlWallet.present()`.
 */
export function createProofProviderFor(
  zkConfigProvider: ZKConfigProvider<string>,
  config?: ProvingProviderConfig,
): ProofProvider {
  if (config?.mode === 'proof-server' && config.url) {
    return httpClientProofProvider(config.url, zkConfigProvider, {
      timeout: config.timeout,
      headers: config.headers,
    })
  }
  return createInProcessProofProvider(zkConfigProvider)
}

/**
 * Resolve a `ProvingProviderConfig` from `@owlid/config`. Returns a `wasm`
 * config when no proof-server URL is set, regardless of `provingMode`.
 * Callers can also pass an explicit config to override the global one.
 *
 * Logs a warning the first time `provingMode === 'proof-server'` resolves
 * with an empty URL — that's a misconfiguration that would otherwise
 * silently prove in-process and surprise the holder.
 */
let warnedMissingProofServerUrl = false
export function resolveProvingConfig(override?: ProvingProviderConfig): ProvingProviderConfig {
  if (override) return override
  const mode: ProvingMode = getProvingMode()
  if (mode === 'proof-server') {
    const url = getProofServerUrl()
    if (url) return { mode: 'proof-server', url }
    if (!warnedMissingProofServerUrl) {
      warnedMissingProofServerUrl = true
      // eslint-disable-next-line no-console
      console.warn(
        '[@owlid/sdk] provingMode=proof-server but proofServerUrl is empty — falling back to in-process WASM proving. Set `proofServerUrl` in configure() or window.__OWLID_CONFIG__.',
      )
    }
  }
  return { mode: 'wasm' }
}
