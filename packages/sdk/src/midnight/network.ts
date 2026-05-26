/**
 * INTERNAL — process-global initialiser for the midnight-js network id.
 *
 * `createUnprovenCallTx` and every wallet/contract entry point read the
 * network id from a global slot in `@midnight-ntwrk/midnight-js-network-id`.
 * Without `setNetworkId()` they throw "Network ID has not been configured".
 *
 * The SDK fetches the id once per process from the verification-service
 * (`GET /midnight/info`, the operator's MIDNIGHT_NETWORK_ID env), then
 * calls `setNetworkId()`. Memoised — the second call is a no-op. The
 * predicate orchestrator awaits this before any prove step, so callers
 * never have to think about it.
 */

import { setNetworkId, NetworkId } from '@midnight-ntwrk/midnight-js-network-id'
import { getMonitoringApi } from '@owlid/verifier-client'

let configured = false
let inflight: Promise<void> | null = null

/**
 * Ensure midnight-js is bound to the same network id the
 * verification-service / sidecar are running against. Concurrent calls
 * share a single in-flight fetch.
 */
export function ensureMidnightNetworkConfigured(): Promise<void> {
  if (configured) return Promise.resolve()
  if (inflight) return inflight
  inflight = (async () => {
    const { networkId } = await getMonitoringApi().getMidnightInfo()
    setNetworkId(networkId as NetworkId)
    configured = true
  })().finally(() => {
    inflight = null
  })
  return inflight
}

/** Reset the memoised state — tests only. */
export function __resetMidnightNetworkConfigForTests(): void {
  configured = false
  inflight = null
}
