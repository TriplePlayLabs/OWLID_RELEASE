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
import * as ledger from '@midnight-ntwrk/ledger-v8'
import { DustAddress, MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format'
import {
  dustGenerationHealth,
  registerNightForDust,
  walletDiagnosticSnapshot,
  type DustGenerationHealth,
  type HeadlessWallet,
} from './wallet.js'
import { log } from './log.js'
import { createSubmitPipeline } from './submit-pipeline.js'

/** Tight cap so a wedged `firstValueFrom` doesn't keep the holder's
 *  HTTP request open forever. 30 s comfortably covers a single
 *  WebSocket reconnect back-off cycle (1 s → 2 min capped in the SDK
 *  retry, but the first few retries are quick) without sitting at the
 *  Cloud Run 5-min request cap. */
const ENSURE_READY_TIMEOUT_MS = Number(process.env.WALLET_ENSURE_TIMEOUT_MS ?? 30_000)
const MONITOR_THROTTLE_MS = 15_000

/** Re-register any freshly-arrived NIGHT UTXOs for dust generation on
 *  this cadence. Without this, a NIGHT top-up after the wallet was
 *  first deployed just sits unregistered forever — dust never accrues
 *  off it, and the wallet eventually runs the existing dust pool dry.
 *  Deploy.ts calls `registerNightForDust` once at first boot; this
 *  loop handles every subsequent top-up. */
const DUST_REGISTER_INTERVAL_MS = Number(process.env.WALLET_DUST_REGISTER_INTERVAL_MS ?? 5 * 60_000)

/** Dust health log cadence. Emits `wallet.dust.health` so operators can
 *  graph `rate` / `balance` / `runway` and answer "when do we run out
 *  of dust?" without scraping a snapshot. */
const DUST_HEALTH_LOG_INTERVAL_MS = Number(process.env.WALLET_DUST_HEALTH_LOG_INTERVAL_MS ?? 60_000)

/** Floor under which `wallet.dust.low` is emitted at WARNING. Default
 *  is 1× the SDK's `additionalFeeOverhead` constant in `wallet.ts`
 *  (`300_000_000_000_000n` Specks) — once the balance dips below a
 *  single typical tx fee, the next attestation will likely fail. */
const DUST_FLOOR = BigInt(process.env.WALLET_DUST_FLOOR ?? '300000000000000')

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
  /** Per-sub-wallet sync ratio in [0, 1]. Lace surfaces this in its
   *  DustTankProgressIndicator; operators can plot "which sub-wallet
   *  is the slow leg" without scraping logs. NaN when the SDK's
   *  progress accessors don't expose a ratio (sub-wallet still
   *  starting). */
  syncRatio: {
    shielded: number
    unshielded: number
    dust: number
  }
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
  /** Balance + submit a transaction with full Lace-style safeguards:
   *
   *  1. `ensureReady` — wait for the wallet to be connected.
   *  2. preflight — `calculateTransactionFee` + dust comparison so we
   *     reject impossible txs BEFORE consuming pending dust UTXOs
   *     (matches Lace's `build-tx.ts` warning path).
   *  3. serialize — one in-flight balance+submit at a time so
   *     concurrent attestations don't fight for the same dust pool and
   *     leave each other stuck on `pendingCoins`.
   *  4. retry on `InsufficientFunds` — sweep the reaper, wait up to
   *     `DUST_REFILL_WAIT_MS` for dust to refill, then try ONCE more.
   *
   *  Always reaches `facade.submitTransaction` on the actual submit
   *  step so the SDK's built-in `revertTransaction` rollback path
   *  fires on failure (Lace pins this assertion in submit-tx.ts).
   *
   *  Throws on terminal failure; never silently drops. Callers that
   *  need fire-and-forget semantics should wrap in their own outbox.
   */
  submitTx(tx: unknown): Promise<unknown>
  /** Health + balance snapshot for `/health/wallet`. */
  snapshot(): Promise<Record<string, unknown>>
  /** Dust-specific snapshot for `/health/wallet/dust` — surfaces the
   *  same telemetry Lace shows in its DustTankProgressIndicator. */
  dustSnapshot(): Promise<DustSnapshotPayload>
  /** Stop the supervisor and the underlying wallet. */
  stop(): Promise<void>
}

export interface DustSnapshotPayload {
  balance: string
  floor: string
  belowFloor: boolean
  /** Wallet addresses for operator top-up. The dust address is what to
   *  point a faucet / `transfer-night` script at; the unshielded
   *  address is what shows up in NIGHT-token UI. */
  addresses: {
    unshielded: string
    shielded: string
    dust: string
  }
  /** Current NIGHT balances — fuel that produces dust. */
  night: {
    unshielded: string
    shielded: string
  }
  generation: {
    currentValue: string
    maxCap: string
    rate: string
    decayTimeMs: number | undefined
    maxCapReachedAtMs: number | undefined
    registeredNightCount: number
    unregisteredNightCount: number
    perCoin: ReadonlyArray<{
      nightValue: string
      generatedNow: string
      maxCap: string
      rate: string
      decayTimeMs: number | undefined
      maxCapReachedAtMs: number | undefined
    }>
  } | null
  /** Wall-clock ms until `balance` reaches `floor` at the current rate
   *  (assuming no spending). Negative when already below floor; null
   *  when `rate === 0n` (forever-stalled). */
  runwayMs: number | null
  /** Wall-clock ms of the most recent successful submit, for sanity
   *  against "is the wallet actually doing anything". */
  lastSubmitOkAt: string | null
  /** Most recent terminal failure timestamp. */
  lastSubmitFailAt: string | null
  /** Number of submits waiting on the in-process serializer. */
  queueDepth: number
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

/** Bounded settle-wait before retrying a balance that hit a transient dust
 *  shortfall. The dust balance is time-accrued and propagates through
 *  `combineLatest`, so `dust.balance(now)` reads `0n` for a beat right after a
 *  prior submit even when the chain dust is plentiful. A short wait lets the
 *  observable settle, then we retry ONCE. Deliberately small (was a 90s
 *  refill-wait before — that was the misfeature, not the retry itself). */
const DUST_RETRY_WAIT_MS = Number(process.env.WALLET_DUST_RETRY_WAIT_MS ?? 3_000)

/** Grace applied to `reapStalePending` ON a dust shortfall (NOT the 35-min
 *  periodic grace). A balance shortfall while the chain dust is plentiful is
 *  itself proof the local pending set is hostage-holding dust the chain has
 *  already released — a tx silently dropped from the mempool never reaches
 *  FAILURE finalization (so the live-evict subscription misses it) and would
 *  otherwise stay pending the full periodic grace. Real failures finalize in
 *  ms (live-evict) and preview finality is seconds, so anything pending past
 *  this is overwhelmingly dropped. Short enough that an actively-tested wallet
 *  recovers within one retry instead of waiting out the periodic reaper. */
const DUST_SHORTFALL_REAP_GRACE_MS = Number(
  process.env.WALLET_DUST_SHORTFALL_REAP_GRACE_MS ?? 90_000,
)

/** How many times the balance is retried on a dust shortfall (each retry reaps
 *  hostage pending with the short grace, then waits for the dust observable to
 *  settle). The default 1 was too few for an actively-tested wallet that has
 *  accumulated several dropped-tx pending holds. */
const DUST_RETRY_ATTEMPTS = Number(process.env.WALLET_DUST_RETRY_ATTEMPTS ?? 3)

export async function startWalletSupervisor(
  createWallet: () => Promise<HeadlessWallet>,
): Promise<WalletSupervisor> {
  const wallet = await createWallet()
  let sub: Rx.Subscription | null = null
  let reaperTimer: ReturnType<typeof setInterval> | null = null
  let dustRegisterTimer: ReturnType<typeof setInterval> | null = null
  let dustHealthTimer: ReturnType<typeof setInterval> | null = null
  let latest: WalletHealth | null = null
  let latestDust: DustGenerationHealth | null = null
  let stopped = false
  // For state-transition logging we only emit when `ready` flips,
  // not on every monitor tick (every 15 s by default).
  let lastReadyLogged: boolean | null = null
  let lastBelowFloorLogged = false
  let lastSubmitOkAt: number | null = null
  let lastSubmitFailAt: number | null = null

  // Single-writer serializer. Concurrent `submitTx` calls race for the
  // same dust pool — without a queue each one's `balanceTx` reserves
  // pending dust UTXOs and the next one fails with `InsufficientFunds`
  // even though the chain has plenty. Tail-chain promises so callers
  // still get parallel-looking call sites with serialized execution.
  let writeChain: Promise<unknown> = Promise.resolve()
  const writeQueueDepth = { current: 0 }
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    writeQueueDepth.current++
    const next = writeChain.then(fn, fn)
    // `writeChain` only sequences the NEXT job, so it must NEVER reject:
    // a terminal `submitTx` failure with no follow-up job behind it would
    // otherwise leave this derived promise rejected-and-unhandled (an
    // `unhandledRejection` that can take the sidecar down under low
    // traffic). The caller owns `next` and its rejection; the chain link
    // swallows so it always settles. Sequencing is preserved — `fn` still
    // runs only after the previous job completes (success or failure).
    writeChain = next.then(
      () => {
        writeQueueDepth.current--
      },
      () => {
        writeQueueDepth.current--
      },
    )
    return next as Promise<T>
  }

  const computeHealth = (state: any): WalletHealth => {
    // Per `abstractions/SyncProgress.ts:isCompleteWithin`, the
    // canonical "safe to balance against" predicate is
    // `isConnected && applyLag <= maxGap`, with default maxGap = 50.
    const shieldedConnected = safeBool(() => state.shielded?.state?.progress?.isCompleteWithin())
    const unshieldedConnected = safeBool(() => state.unshielded?.progress?.isCompleteWithin())
    const dustConnected = safeBool(() => state.dust?.state?.progress?.isCompleteWithin())
    const fullySynced = !!state.isSynced
    const ready = shieldedConnected && unshieldedConnected && dustConnected
    const syncRatio = {
      shielded: safeRatio(state.shielded?.state?.progress),
      unshielded: safeRatio(state.unshielded?.progress),
      dust: safeRatio(state.dust?.state?.progress),
    }
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
      syncRatio,
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
  const reapStalePending = async (graceMsOverride?: number): Promise<void> => {
    const grace = graceMsOverride ?? PENDING_REAPER_GRACE_MS
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
        if (ageMs < grace) {
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
        graceMs: grace,
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
  //
  // Wrap in `serialize()` so the reaper's `facade.revertTransaction`
  // (which mutates `pendingDust` / `pendingCoins` state) can NOT run
  // concurrently with a serialized `wallet.balanceTx` mid-balance —
  // otherwise the in-flight tx's dust selection sees state mutate
  // underneath it and surfaces as `Wallet.InsufficientFunds`.
  const reapSerialized = () =>
    serialize(reapStalePending).catch((e) =>
      log.warn('wallet.reap.serialize.error', { err: String(e) }),
    )
  void reapSerialized()
  reaperTimer = setInterval(() => void reapSerialized(), PENDING_REAPER_INTERVAL_MS)
  reaperTimer.unref?.()

  // Live-evict pending entries the moment the indexer finalizes them
  // as FAILURE / PARTIAL_SUCCESS. The SDK auto-clears SUCCESS entries
  // (`saveResult → clear`) but failures linger with `result.status`
  // attached, hostage-holding dust UTXOs until the periodic reaper
  // sweeps. Subscribe to the stream once and revert as soon as we
  // see a non-SUCCESS result. Cuts pending-dust holds from minutes
  // (reaper interval) to milliseconds (indexer poll).
  let pendingSub: Rx.Subscription | null = null
  const subscribePendingFinalized = (): void => {
    const svc = (
      wallet.facade as unknown as {
        pendingTransactionsService?: {
          state: () => Rx.Observable<{
            all?: ReadonlyArray<{ tx: unknown; result?: { status?: string } }>
          }>
        }
      }
    ).pendingTransactionsService
    if (!svc) return
    pendingSub?.unsubscribe()
    pendingSub = svc.state().subscribe({
      next: (snap) => {
        const failed = (snap.all ?? []).filter(
          (it) => it.result?.status === 'FAILURE' || it.result?.status === 'PARTIAL_SUCCESS',
        )
        if (failed.length === 0) return
        void serialize(async () => {
          for (const item of failed) {
            try {
              await (
                wallet.facade as unknown as { revertTransaction: (tx: unknown) => Promise<void> }
              ).revertTransaction(item.tx)
              log.info('wallet.pending.finalized.reverted', { status: item.result?.status })
            } catch (e) {
              log.warn('wallet.pending.finalized.revert.failed', {
                err: e instanceof Error ? e.message : String(e),
              })
            }
          }
        }).catch(() => undefined)
      },
      error: (e) =>
        log.warn('wallet.pending.finalized.stream.error', {
          err: e instanceof Error ? e.message : String(e),
        }),
    })
  }
  subscribePendingFinalized()

  // Suppress duplicate registration submissions while the previous
  // registration tx is still finalizing on chain. Without this the
  // 5-min loop re-reads the same un-registered list (the
  // `meta.registeredForDustGeneration` flag only flips after chain
  // finalization, several blocks) and submits another registration
  // tx every tick, burning dust on fees.
  let lastRegistrationAt: number | null = null
  const REGISTRATION_FINALIZATION_GUARD_MS = 10 * 60_000

  /**
   * Re-register any NIGHT UTXOs that arrived after first deploy.
   *
   * Lace models dust designation as a recurring user flow
   * (`flowType: 'dust-designation'`) — every time the user has fresh
   * un-designated NIGHT, the UI invites them to register it. A
   * headless sidecar has no user, so we run this loop instead. Without
   * it, a top-up sent to fix "wallet dust running low" sits idle: the
   * NIGHT shows up in `unshielded.availableCoins` but its
   * `meta.registeredForDustGeneration` stays false until somebody
   * calls `registerNightUtxosForDustGeneration` over it.
   *
   * `registerNightForDust` is itself a dust-spending tx, so this is a
   * write — funnel it through the serializer so it doesn't race
   * concurrent attestation submits.
   */
  const dustRegistrationLoop = async (): Promise<void> => {
    if (stopped) return
    // Skip ticks while a recently-submitted registration is still
    // finalizing — the on-chain `registeredForDustGeneration` flag
    // hasn't flipped yet so the unregistered list still shows the
    // same coins.
    if (
      lastRegistrationAt !== null &&
      Date.now() - lastRegistrationAt < REGISTRATION_FINALIZATION_GUARD_MS
    ) {
      return
    }
    try {
      await serialize(async () => {
        const state = (await Rx.firstValueFrom(wallet.facade.state())) as any
        const unreg =
          state.unshielded?.availableCoins?.filter(
            (c: any) => c.meta?.registeredForDustGeneration === false,
          ) ?? []
        if (unreg.length === 0) return
        log.info('wallet.dust.register.start', { count: unreg.length })
        // `waitForDust: false` — we don't block the serializer for
        // ledger inclusion of the registration tx; it can take
        // multiple blocks and the next attestation can wait on the
        // SDK's own `pendingCoins` instead.
        const ok = await registerNightForDust(wallet, { waitForDust: false })
        if (ok) lastRegistrationAt = Date.now()
        log.info(ok ? 'wallet.dust.register.ok' : 'wallet.dust.register.skip', {
          count: unreg.length,
        })
      })
    } catch (e) {
      log.warn('wallet.dust.register.error', {
        err: e instanceof Error ? e.message : String(e),
      })
    }
  }
  // Run once at startup (covers the case where `initClient` boots the
  // supervisor after the wallet was funded but before
  // `registerNightForDust` ran in `deploy.ts`).
  void dustRegistrationLoop()
  dustRegisterTimer = setInterval(() => void dustRegistrationLoop(), DUST_REGISTER_INTERVAL_MS)
  dustRegisterTimer.unref?.()

  /**
   * Per-minute structured dust telemetry. Mirrors what Lace's
   * `useMidnightDustData` exposes to the UI: balance, rate, cap,
   * runway. Logged at INFO so it's queryable, plus a WARNING edge
   * when the balance crosses `DUST_FLOOR`.
   */
  const emitDustHealth = async (): Promise<void> => {
    if (stopped) return
    try {
      const gen = await dustGenerationHealth(wallet)
      latestDust = gen
      const state = (await Rx.firstValueFrom(wallet.facade.state())) as any
      const balance: bigint = state.dust?.balance(new Date()) ?? 0n
      const runwayMs = computeRunwayMs(balance, gen?.rate ?? 0n, DUST_FLOOR, gen?.decayTimeMs)
      log.info('wallet.dust.health', {
        balance,
        floor: DUST_FLOOR,
        rate: gen?.rate ?? 0n,
        currentValue: gen?.currentValue ?? 0n,
        maxCap: gen?.maxCap ?? 0n,
        registeredNight: gen?.registeredNightCount ?? 0,
        unregisteredNight: gen?.unregisteredNightCount ?? 0,
        runwayMs,
      })
      // `state.dust.balance(now)` returns `0n` transiently mid-replay
      // (see file header). Don't fire the edge-triggered low alert on
      // that transient — only trust it once balance has been non-zero
      // OR there's no NIGHT funding at all (a real dust-zero state).
      const balanceUnknown = balance === 0n && (gen?.registeredNightCount ?? 0) > 0
      const belowFloor = !balanceUnknown && balance < DUST_FLOOR
      if (belowFloor !== lastBelowFloorLogged) {
        if (belowFloor) {
          log.warn('wallet.dust.low', {
            balance,
            floor: DUST_FLOOR,
            rate: gen?.rate ?? 0n,
            registeredNight: gen?.registeredNightCount ?? 0,
            unregisteredNight: gen?.unregisteredNightCount ?? 0,
          })
        } else {
          log.info('wallet.dust.recovered', { balance, floor: DUST_FLOOR })
        }
        lastBelowFloorLogged = belowFloor
      }
    } catch (e) {
      log.warn('wallet.dust.health.error', {
        err: e instanceof Error ? e.message : String(e),
      })
    }
  }
  void emitDustHealth()
  dustHealthTimer = setInterval(() => void emitDustHealth(), DUST_HEALTH_LOG_INTERVAL_MS)
  dustHealthTimer.unref?.()

  const ensureReadyImpl = async (timeoutMs: number = ENSURE_READY_TIMEOUT_MS): Promise<void> => {
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
      // Use the same `isCompleteWithin` predicate the hot subscription
      // uses for `latest.ready`. Previously the slow path filtered on
      // strict `isSynced` (lag === 0); on preview with normal indexer
      // lag the fast path would say not-ready while strict isSynced
      // never flipped, causing 30 s timeouts even though the wallet
      // was perfectly able to balance + submit.
      await Rx.firstValueFrom(
        Rx.race(
          wallet.facade.state().pipe(
            Rx.filter((s: unknown) => {
              const st = s as any
              return (
                safeBool(() => st.shielded?.state?.progress?.isCompleteWithin()) &&
                safeBool(() => st.unshielded?.progress?.isCompleteWithin()) &&
                safeBool(() => st.dust?.state?.progress?.isCompleteWithin())
              )
            }),
          ),
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
  }

  // Pipelined submit: balance+reserve serialized, broadcast outside the lock
  // (see submit-pipeline.ts). This is what lets two users' submits overlap
  // instead of queueing one whole block apart.
  const submitPipeline = createSubmitPipeline({
    ensureReady: ensureReadyImpl,
    balanceTx: (tx) => wallet.balanceTx(tx),
    reserve: (balanced) => wallet.reserve(balanced),
    broadcast: (balanced) => wallet.broadcast(balanced),
    revert: (balanced) => wallet.revert(balanced),
    reapStalePending,
    serialize,
    dustRetryWaitMs: DUST_RETRY_WAIT_MS,
    dustShortfallReapGraceMs: DUST_SHORTFALL_REAP_GRACE_MS,
    dustRetryAttempts: DUST_RETRY_ATTEMPTS,
    onEvent: (event, fields) => {
      if (event === 'submit.broadcast.failed' || event === 'submit.dust-short.retry') {
        log.warn(`wallet.${event}`, fields)
      } else {
        log.info(`wallet.${event}`, fields)
      }
    },
  })

  return {
    getWallet: () => wallet,

    ensureReady: ensureReadyImpl,

    notifySubmitFailed(): void {
      // Retained for API compatibility with prior call sites. The SDK
      // handles transient submit errors via its own retry path; a
      // wallet-level rebuild here would discard in-memory UTXO state
      // and is never the right response.
      log.warn('wallet.submitFailed.notified', {})
    },

    async submitTx(tx: unknown): Promise<unknown> {
      try {
        const out = await submitPipeline(tx)
        lastSubmitOkAt = Date.now()
        return out
      } catch (e) {
        lastSubmitFailAt = Date.now()
        throw e
      }
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
                syncRatio: latest.syncRatio,
                dust: latest.dust.toString(),
                at: new Date(latest.at).toISOString(),
              }
            : null,
          queueDepth: writeQueueDepth.current,
        },
      }
    },

    async dustSnapshot(): Promise<DustSnapshotPayload> {
      const gen = await dustGenerationHealth(wallet).catch(() => latestDust)
      const state = (await Rx.firstValueFrom(wallet.facade.state())) as any
      const balance: bigint = state.dust?.balance(new Date()) ?? 0n
      const networkId = process.env.MIDNIGHT_NETWORK_ID ?? 'undeployed'
      const unshieldedAddr = wallet.unshieldedKeystore.getBech32Address().asString()
      // `state.shielded.address` is populated lazily — during a hot
      // resub or right after `connect` it can be undefined. Return an
      // empty string rather than throwing so the rest of the snapshot
      // (the dust telemetry an operator actually needs to debug) still
      // surfaces.
      const shieldedAddr = state.shielded?.address
        ? MidnightBech32m.encode(networkId, state.shielded.address).asString()
        : ''
      const dustAddr = DustAddress.encodePublicKey(networkId, wallet.dustSecretKey.publicKey)
      const nightUt = ledger.nativeToken().raw
      return {
        balance: balance.toString(),
        floor: DUST_FLOOR.toString(),
        belowFloor: balance < DUST_FLOOR,
        addresses: {
          unshielded: unshieldedAddr,
          shielded: shieldedAddr,
          dust: dustAddr,
        },
        night: {
          unshielded: (state.unshielded?.balances?.[nightUt] ?? 0n).toString(),
          shielded: (state.shielded?.balances?.[nightUt] ?? 0n).toString(),
        },
        generation: gen
          ? {
              currentValue: gen.currentValue.toString(),
              maxCap: gen.maxCap.toString(),
              rate: gen.rate.toString(),
              decayTimeMs: gen.decayTimeMs,
              maxCapReachedAtMs: gen.maxCapReachedAtMs,
              registeredNightCount: gen.registeredNightCount,
              unregisteredNightCount: gen.unregisteredNightCount,
              perCoin: gen.perCoin,
            }
          : null,
        runwayMs: computeRunwayMs(balance, gen?.rate ?? 0n, DUST_FLOOR, gen?.decayTimeMs),
        lastSubmitOkAt: lastSubmitOkAt ? new Date(lastSubmitOkAt).toISOString() : null,
        lastSubmitFailAt: lastSubmitFailAt ? new Date(lastSubmitFailAt).toISOString() : null,
        queueDepth: writeQueueDepth.current,
      }
    },

    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      sub?.unsubscribe()
      pendingSub?.unsubscribe()
      if (reaperTimer) clearInterval(reaperTimer)
      if (dustRegisterTimer) clearInterval(dustRegisterTimer)
      if (dustHealthTimer) clearInterval(dustHealthTimer)
      await wallet.close().catch((e) => log.error('wallet.close.error', { err: String(e) }))
    },
  }
}

/** Time in ms until `balance` decays from current down to `floor`,
 *  ignoring spending.
 *
 *  Only meaningful when at least one backing NIGHT was spent (the SDK
 *  sets `decayTimeMs` on that UTXO). Until then, `rate` represents
 *  GENERATION — the balance is growing toward `maxCap`, not depleting
 *  — so any "runway until floor" number would be misleading. Returns
 *  `null` in that case and the operator reads `belowFloor` / `rate` /
 *  `unregisteredNightCount` directly. */
function computeRunwayMs(
  balance: bigint,
  rate: bigint,
  floor: bigint,
  decayTimeMs: number | undefined,
): number | null {
  if (rate <= 0n) return null
  if (decayTimeMs === undefined) return null
  if (balance <= floor) return 0
  const remaining = balance - floor
  const ms = remaining / rate
  if (ms > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
  return Number(ms)
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

/** Per-sub-wallet sync ratio in [0, 1]. The SDK's progress objects
 *  expose either `applyLag` + `highestRelevantIndex` (in which case
 *  ratio = appliedIndex / highestRelevantIndex), or `progressPercent`
 *  directly. Returns NaN when neither shape is present (sub-wallet
 *  still starting); callers should treat NaN as "unknown". */
function safeRatio(progress: unknown): number {
  if (!progress) return Number.NaN
  try {
    const p = progress as {
      appliedIndex?: bigint
      highestRelevantWalletIndex?: bigint
      highestRelevantIndex?: bigint
      appliedId?: bigint
      highestTransactionId?: bigint
    }
    // Shielded / dust progress uses {appliedIndex, highestRelevantWalletIndex}.
    if (p.appliedIndex !== undefined && p.highestRelevantWalletIndex !== undefined) {
      const hi = p.highestRelevantWalletIndex
      if (hi === 0n) return 1
      return Number(p.appliedIndex) / Number(hi)
    }
    // Unshielded progress uses {appliedId, highestTransactionId}.
    if (p.appliedId !== undefined && p.highestTransactionId !== undefined) {
      const hi = p.highestTransactionId
      if (hi === 0n) return 1
      return Number(p.appliedId) / Number(hi)
    }
    return Number.NaN
  } catch {
    return Number.NaN
  }
}
