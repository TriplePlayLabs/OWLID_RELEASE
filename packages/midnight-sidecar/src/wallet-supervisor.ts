/**
 * Wallet readiness gate.
 *
 * The Midnight Wallet SDK self-heals WebSocket drops at the source: each
 * sub-wallet's `RunningV1Variant.startSync` wraps the indexer subscription
 * in `Stream.retry` with exponential back-off (1s → 2min cap) and the
 * in-memory UTXO / dust state survives the retry intact. Rebuilding the
 * `WalletFacade` from scratch — what an earlier iteration of this file
 * did on any unhealthy sample — discards the in-memory state and forces
 * a full chain re-sync (5–10 min on preview), which is the exact
 * latency the rebuild was meant to prevent.
 *
 * This module therefore does NOT rebuild the wallet. It only:
 *   1. Holds a hot subscription on `facade.state()` so the most recent
 *      sync snapshot is always available without re-subscribing per
 *      request (each sub-wallet's `state` already uses `shareReplay`
 *      bufferSize=1 internally, so this also acts as a keep-alive).
 *   2. Exposes `ensureReady(timeoutMs)` — a thin wrapper around the
 *      SDK's canonical `firstValueFrom(state().pipe(filter(s => s.isSynced)))`
 *      with a tight default timeout. Callers that need to balance or
 *      submit a tx call this once at the head of the operation.
 *   3. Emits structured logs on every state transition so Cloud Logging
 *      can answer "was the wallet ready when the tx came in" without
 *      reading the source.
 *
 * Health predicate uses the SDK's `isCompleteWithin()` (default
 * `maxGap = 50` blocks) rather than the strict `isSynced` (`maxGap = 0`).
 * `isCompleteWithin` is the looser predicate the SDK ships for
 * "connected AND not severely behind"; matches the contract `balanceTx`
 * needs and avoids blocking on every single new block arriving.
 *
 * What this module deliberately does NOT check:
 *   - `state.dust.balance(new Date()) > 0n` — this returns `0n`
 *     transiently while `combineLatest` propagates a fresh dust
 *     sub-state mid-replay (verified against the SDK source). It is
 *     not a safe usability signal. Run out of DUST is a real failure
 *     mode but it surfaces as a `balanceTx` error, not as a state
 *     emission.
 */

import * as Rx from 'rxjs'
import { walletDiagnosticSnapshot, type HeadlessWallet } from './wallet.js'
import { log } from './log.js'

/** Tight cap so a wedged `firstValueFrom` doesn't keep the holder's
 *  HTTP request open forever. 30 s comfortably covers a single
 *  WebSocket reconnect back-off cycle (1 s → 2 min capped in the SDK
 *  retry, but the first few retries are quick) without sitting at the
 *  Cloud Run 5-min request cap. */
const ENSURE_READY_TIMEOUT_MS = Number(process.env.WALLET_ENSURE_TIMEOUT_MS ?? 30_000)
const MONITOR_THROTTLE_MS = 15_000

interface WalletHealth {
  /** All three sub-wallets connected AND lag ≤ 50 blocks (SDK default
   *  for `isCompleteWithin`). The looser predicate matches the SDK's
   *  own `waitForSyncedState(allowedGap = 50)` semantics. */
  ready: boolean
  /** Strict: `isSynced` requires lag === 0 on all three sub-wallets. */
  fullySynced: boolean
  shieldedConnected: boolean
  unshieldedConnected: boolean
  dustConnected: boolean
  /** Dust balance at observation time — informational, NOT used as a
   *  health signal (see file header). */
  dust: bigint
  at: number
}

export interface WalletSupervisor {
  /** Current wallet. Reference is stable for the supervisor's lifetime
   *  — this module never rebuilds the wallet. */
  getWallet(): HeadlessWallet
  /** Wait until the wallet reports `ready` per `isCompleteWithin`.
   *  Returns when ready; throws when `timeoutMs` elapses without it
   *  reaching ready. Cheap when already ready — resolves on the
   *  current `shareReplay`-buffered emission. */
  ensureReady(timeoutMs?: number): Promise<void>
  /** Hook retained for source-compat with the older API; now a no-op
   *  beyond emitting a log. The SDK's own `submitTx` retry path handles
   *  transient submit failures; rebuilding the wallet does not help. */
  notifySubmitFailed(): void
  /** Health + balance snapshot for `/health/wallet`. */
  snapshot(): Promise<Record<string, unknown>>
  /** Stop the supervisor and the underlying wallet. */
  stop(): Promise<void>
}

/** Mempool TTL we set on each balanced tx (see `balanceTx` in
 *  `wallet.ts`), in ms. After this elapses with no chain finalization
 *  the tx is dead on chain — its dust UTXOs are spendable again, but
 *  the SDK's local `pendingDust` set still holds them. The reaper
 *  reverts these locally so the balancer can find them.
 *
 *  Chain TTL is 30 min; we wait 35 min before reverting to absorb
 *  clock skew + give finality observers a last chance to mark the
 *  tx Failed so the SDK's own auto-revert fires first. */
const PENDING_REAPER_GRACE_MS = Number(process.env.WALLET_PENDING_REAPER_GRACE_MS ?? 35 * 60_000)
const PENDING_REAPER_INTERVAL_MS = Number(process.env.WALLET_PENDING_REAPER_INTERVAL_MS ?? 60_000)

export async function startWalletSupervisor(
  createWallet: () => Promise<HeadlessWallet>,
): Promise<WalletSupervisor> {
  const wallet = await createWallet()
  let sub: Rx.Subscription | null = null
  let reaperTimer: ReturnType<typeof setInterval> | null = null
  let latest: WalletHealth | null = null
  let stopped = false
  // For state-transition logging we only emit when `ready` flips,
  // not on every monitor tick (every 15 s by default).
  let lastReadyLogged: boolean | null = null

  const computeHealth = (state: any): WalletHealth => {
    // Per `abstractions/SyncProgress.ts:isCompleteWithin`, the
    // canonical "safe to balance against" predicate is
    // `isConnected && applyLag <= maxGap`, with default maxGap = 50.
    const shieldedConnected = safeBool(() => state.shielded?.state?.progress?.isCompleteWithin())
    const unshieldedConnected = safeBool(() => state.unshielded?.progress?.isCompleteWithin())
    const dustConnected = safeBool(() => state.dust?.state?.progress?.isCompleteWithin())
    const fullySynced = !!state.isSynced
    const ready = shieldedConnected && unshieldedConnected && dustConnected
    let dust = 0n
    try {
      dust = state.dust?.balance(new Date()) ?? 0n
    } catch {
      dust = 0n
    }
    return {
      ready,
      fullySynced,
      shieldedConnected,
      unshieldedConnected,
      dustConnected,
      dust,
      at: Date.now(),
    }
  }

  const subscribe = (w: HeadlessWallet): void => {
    sub?.unsubscribe()
    sub = w.facade
      .state()
      .pipe(Rx.throttleTime(MONITOR_THROTTLE_MS, undefined, { leading: true, trailing: true }))
      .subscribe((state: unknown) => {
        const h = computeHealth(state)
        latest = h
        // Periodic verbose snapshot for trace queries.
        log.debug('wallet.state', {
          ready: h.ready,
          fullySynced: h.fullySynced,
          shieldedConnected: h.shieldedConnected,
          unshieldedConnected: h.unshieldedConnected,
          dustConnected: h.dustConnected,
          dust: h.dust,
        })
        // Edge-triggered transition log so the GCP timeline shows
        // exactly when the wallet flipped ready / not-ready.
        if (lastReadyLogged !== h.ready) {
          if (h.ready) {
            log.info('wallet.ready', { dust: h.dust, fullySynced: h.fullySynced })
          } else {
            log.warn('wallet.unready', {
              shieldedConnected: h.shieldedConnected,
              unshieldedConnected: h.unshieldedConnected,
              dustConnected: h.dustConnected,
            })
          }
          lastReadyLogged = h.ready
        }
      })
  }

  subscribe(wallet)

  /**
   * Reap stale entries from the SDK's local `pendingDust` set.
   *
   * Why this exists: every successful `submitTransaction` adds the
   * tx to `pendingTransactionsService`, which marks its dust UTXOs
   * as "pending" inside the dust wallet. `state.dust.availableCoins`
   * is then `utxos - pendingDust`. The SDK auto-clears a pending
   * entry only when the indexer observes the tx reach `Failed`
   * finalization. A tx that gets silently dropped from the mempool
   * (peer disconnect, mempool eviction, chain reorg before
   * finalization) never reaches `Failed` — its pending entry stays
   * in memory forever, hostage-holding dust UTXOs that the chain
   * has long since released. Next `balanceTx` returns "Insufficient
   * Funds: could not balance dust" even when `state.dust.balance`
   * shows plenty.
   *
   * The reaper walks `pendingTransactionsService.state()` every
   * minute and reverts any entry older than the chain TTL — the
   * dust the entry references is already spendable on-chain so it
   * is safe to release locally. Reverting a tx that did finalize
   * after our grace window is harmless: `revertTransaction` is
   * idempotent and the chain UTXO ledger is the source of truth.
   */
  const reapStalePending = async (): Promise<void> => {
    try {
      const svc = (
        wallet.facade as unknown as {
          pendingTransactionsService?: { state: () => Rx.Observable<unknown> }
        }
      ).pendingTransactionsService
      if (!svc) return
      const snapshot = (await Rx.firstValueFrom(svc.state())) as {
        all?: ReadonlyArray<{
          tx: unknown
          creationTime: { epochMillis?: number } | number | string
        }>
      }
      const items = snapshot.all ?? []
      if (items.length === 0) return
      const nowMs = Date.now()
      let reaped = 0
      let kept = 0
      for (const item of items) {
        const createdMs = creationTimeToMs(item.creationTime)
        if (createdMs === null) continue
        const ageMs = nowMs - createdMs
        if (ageMs < PENDING_REAPER_GRACE_MS) {
          kept++
          continue
        }
        try {
          await (
            wallet.facade as unknown as { revertTransaction: (tx: unknown) => Promise<void> }
          ).revertTransaction(item.tx)
          reaped++
        } catch (e) {
          log.warn('wallet.reap.revert.failed', {
            ageMs,
            err: e instanceof Error ? e.message : String(e),
          })
        }
      }
      log.info('wallet.reap.sweep', {
        pending: items.length,
        reaped,
        kept,
        graceMs: PENDING_REAPER_GRACE_MS,
      })
    } catch (e) {
      log.warn('wallet.reap.error', {
        err: e instanceof Error ? e.message : String(e),
      })
    }
  }
  // Kick off immediately at startup (clears stale entries that
  // survived a process restart — possible if a prior revision
  // shipped a serialized pending set), then run on a steady cadence.
  void reapStalePending()
  reaperTimer = setInterval(() => void reapStalePending(), PENDING_REAPER_INTERVAL_MS)
  reaperTimer.unref?.()

  return {
    getWallet: () => wallet,

    async ensureReady(timeoutMs = ENSURE_READY_TIMEOUT_MS): Promise<void> {
      // Fast path: the hot subscription's last sample is already ready.
      if (latest?.ready) {
        log.debug('wallet.ensureReady.fast', { dust: latest.dust })
        return
      }
      log.warn('wallet.ensureReady.wait', {
        timeoutMs,
        shieldedConnected: latest?.shieldedConnected ?? null,
        unshieldedConnected: latest?.unshieldedConnected ?? null,
        dustConnected: latest?.dustConnected ?? null,
      })
      const startedAt = Date.now()
      try {
        // Canonical SDK pattern (`docs-snippets/balancing.ts:24`) —
        // wait for the wallet's own `isSynced` to flip. The strict
        // `isSynced` is appropriate here as a "definitely safe" gate;
        // the looser `isCompleteWithin()` is what we report on the
        // hot subscription for liveness.
        await Rx.firstValueFrom(
          Rx.race(
            wallet.facade.state().pipe(Rx.filter((s: any) => s.isSynced)),
            Rx.timer(timeoutMs).pipe(
              Rx.map(() => {
                throw new Error(`wallet not ready within ${timeoutMs}ms`)
              }),
            ),
          ),
        )
        log.info('wallet.ensureReady.ok', { waitedMs: Date.now() - startedAt })
      } catch (e) {
        log.error('wallet.ensureReady.timeout', {
          waitedMs: Date.now() - startedAt,
          err: e instanceof Error ? e.message : String(e),
        })
        throw e
      }
    },

    notifySubmitFailed(): void {
      // Retained for API compatibility with prior call sites. The SDK
      // handles transient submit errors via its own retry path; a
      // wallet-level rebuild here would discard in-memory UTXO state
      // and is never the right response.
      log.warn('wallet.submitFailed.notified', {})
    },

    async snapshot(): Promise<Record<string, unknown>> {
      const snap = await walletDiagnosticSnapshot(wallet)
      return {
        ...snap,
        supervisor: {
          health: latest
            ? {
                ready: latest.ready,
                fullySynced: latest.fullySynced,
                shieldedConnected: latest.shieldedConnected,
                unshieldedConnected: latest.unshieldedConnected,
                dustConnected: latest.dustConnected,
                dust: latest.dust.toString(),
                at: new Date(latest.at).toISOString(),
              }
            : null,
        },
      }
    },

    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      sub?.unsubscribe()
      if (reaperTimer) clearInterval(reaperTimer)
      await wallet.close().catch((e) => log.error('wallet.close.error', { err: String(e) }))
    },
  }
}

/** `pendingTransactionsService` uses `effect/DateTime.Utc` for
 *  `creationTime`. Public shape varies across effect versions —
 *  inspect at runtime so we don't pull `effect` as a direct dep just
 *  to read epoch millis. Returns null on shapes we don't recognise so
 *  the reaper conservatively keeps the entry. */
function creationTimeToMs(
  t: { epochMillis?: number } | number | string | undefined | null,
): number | null {
  if (t === null || t === undefined) return null
  if (typeof t === 'number') return t
  if (typeof t === 'string') {
    const parsed = Date.parse(t)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof t === 'object' && typeof t.epochMillis === 'number') return t.epochMillis
  // effect 3.x stores epoch millis on a `epochMillis` property; older
  // shape may expose `toEpochMillis()` or `_tag` + nested value. Bail
  // safe.
  return null
}

function safeBool(fn: () => unknown): boolean {
  try {
    return !!fn()
  } catch {
    return false
  }
}
