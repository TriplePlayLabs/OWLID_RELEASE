/**
 * Health-check debounce for the verifier service banner (GH #14 — "service
 * shows repeatedly as going offline").
 *
 * The old code flipped the banner to "offline" on a single failed `/health`
 * fetch, so one slow response or transient blip flapped the UI (and disabled
 * "Scan QR") even though the backend was up. We now retry within a tick and
 * only declare offline after a couple of consecutive failing checks; going
 * back online stays immediate.
 */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Run the health check, retrying a few times within the same tick so a
 *  single transient failure doesn't count. Resolves true on the first
 *  success, false only if every attempt fails. */
export async function checkHealthWithRetry(
  check: () => Promise<boolean>,
  attempts = 2,
  delayMs = 600,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    let healthy = false
    try {
      healthy = await check()
    } catch {
      healthy = false
    }
    if (healthy) return true
    if (i < attempts - 1) await delay(delayMs)
  }
  return false
}

/** Decide the next banner state from the previous state and this check's
 *  result. A healthy result is trusted immediately; an unhealthy result
 *  only flips to offline once `consecutiveFailures` reaches the threshold,
 *  otherwise the last known state is kept (so one blip doesn't flap). */
export function decideServiceOnline(
  prev: boolean | null,
  healthy: boolean,
  consecutiveFailures: number,
  offlineThreshold = 2,
): boolean | null {
  if (healthy) return true
  if (consecutiveFailures >= offlineThreshold) return false
  return prev
}
