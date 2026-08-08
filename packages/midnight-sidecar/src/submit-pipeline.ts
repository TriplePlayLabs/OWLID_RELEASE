/**
 * Pipelined balance+submit orchestration, extracted from the wallet supervisor
 * so the concurrency contract is unit-testable without a live Midnight wallet.
 *
 * The shape that makes concurrent submits actually concurrent:
 *
 *   Phase 1 — SERIALIZED — balance + reserve.
 *     Balancing selects dust/coin UTXOs; `reserve` (addPendingTransaction)
 *     marks them pending. These two MUST be atomic per submit, else two
 *     concurrent balances pick the same UTXO. The serializer guarantees that.
 *
 *   Phase 2 — NOT serialized — broadcast (submit to mempool, return at
 *     `'Submitted'`).
 *     The reservation from phase 1 already excludes this tx's UTXOs from the
 *     next balance, so the slow network leg need not hold the lock. Submit N
 *     pipelines: user B balances while user A's tx is in the mempool/being
 *     included. On failure we re-enter the serializer to `revert` — mutating
 *     pending state outside the lock would corrupt a concurrent balance's
 *     UTXO selection.
 *
 * A dust shortfall throws from `balanceTx` (phase 1, before anything is
 * reserved/submitted) so retrying it can never double-submit. We reap stale
 * pending UTXOs, wait a bounded beat for the dust observable to settle, and
 * retry phase 1 once. Any non-dust failure is terminal.
 */

import { isDustShortfallError } from './dust-errors.js'

export interface SubmitPipelineDeps {
  ensureReady: () => Promise<void>
  balanceTx: (tx: unknown) => Promise<unknown>
  reserve: (balanced: unknown) => Promise<void>
  broadcast: (balanced: unknown) => Promise<unknown>
  revert: (balanced: unknown) => Promise<void>
  /** Reap stale local pending entries hostage-holding dust. The optional
   *  grace override lets the dust-shortfall retry reap more aggressively than
   *  the periodic sweep. */
  reapStalePending: (graceMsOverride?: number) => Promise<void>
  /** The supervisor's single-writer serializer. */
  serialize: <T>(fn: () => Promise<T>) => Promise<T>
  /** Bounded settle-wait before each dust-shortfall retry. */
  dustRetryWaitMs: number
  /** Grace passed to `reapStalePending` on a shortfall — short, because the
   *  shortfall itself proves the pending dust is already released on-chain. */
  dustShortfallReapGraceMs?: number
  /** How many times to retry the balance on a dust shortfall (default 1). */
  dustRetryAttempts?: number
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** Optional structured telemetry hook. */
  onEvent?: (event: string, fields: Record<string, unknown>) => void
}

export function createSubmitPipeline(deps: SubmitPipelineDeps): (tx: unknown) => Promise<unknown> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const emit = deps.onEvent ?? (() => {})

  return async function submit(tx: unknown): Promise<unknown> {
    const balanceAndReserve = async (): Promise<unknown> => {
      const balanced = await deps.balanceTx(tx)
      await deps.reserve(balanced)
      return balanced
    }

    // Phase 1: serialized balance + reserve, with bounded dust-shortfall retries.
    const t0 = Date.now()
    const maxRetries = Math.max(0, deps.dustRetryAttempts ?? 1)
    const reserved = await deps.serialize(async () => {
      await deps.ensureReady()
      for (let attempt = 0; ; attempt++) {
        try {
          return await balanceAndReserve()
        } catch (e) {
          // Only a dust shortfall is retryable, and only up to the cap; every
          // other failure (node reject, contract assert) is terminal.
          if (!isDustShortfallError(e) || attempt >= maxRetries) throw e
          emit('submit.dust-short.retry', {
            attempt: attempt + 1,
            maxRetries,
            err: e instanceof Error ? e.message : String(e),
            waitMs: deps.dustRetryWaitMs,
          })
          // The shortfall proves the local pending set is hostage-holding dust
          // the chain already released — reap with the short shortfall grace,
          // then let the dust observable settle before re-balancing.
          await deps.reapStalePending(deps.dustShortfallReapGraceMs)
          await sleep(deps.dustRetryWaitMs)
        }
      }
    })
    emit('submit.reserved', { balanceMs: Date.now() - t0 })

    // Phase 2: broadcast outside the lock so concurrent submits pipeline.
    const t1 = Date.now()
    try {
      const out = await deps.broadcast(reserved)
      emit('submit.broadcast.ok', { broadcastMs: Date.now() - t1 })
      return out
    } catch (e) {
      emit('submit.broadcast.failed', { err: e instanceof Error ? e.message : String(e) })
      // Revert under the serializer — never mutate pending state concurrently
      // with a balance.
      await deps.serialize(() => deps.revert(reserved)).catch(() => undefined)
      throw e
    }
  }
}
