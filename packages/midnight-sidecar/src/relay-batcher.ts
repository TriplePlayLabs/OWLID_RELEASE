/**
 * Coalesces concurrently-relayed proven attestation txs into a single
 * balanced+submitted chain tx, so ONE ~10s wallet balance amortizes across K
 * attestations instead of paying it per tx.
 *
 * Holders prove independently (off-server). Their proven txs arrive at the
 * relay within ms of each other under load. We buffer them for a short window
 * (or until a max batch size), merge them into one transaction via
 * `Transaction.merge`, and submit once. All jobs in a batch share the
 * resulting chain tx id.
 *
 * Failure is all-or-nothing per batch: a merged tx is one atomic chain tx, so
 * if one member is invalid the whole submit fails and every job in the batch
 * rejects (the holder retries → lands in a fresh batch). v1 keeps this simple;
 * a bisecting retry could isolate a poison tx later.
 *
 * Generic over the tx type so it is unit-testable without the ledger.
 */
export interface RelayBatcherOptions<T> {
  /** Max time the first item in a batch waits for companions. */
  windowMs: number
  /** Hard cap on batch size — flush immediately when reached. */
  maxBatch: number
  /** Merge + balance + submit the batch as one tx; resolves to the shared
   *  chain tx id. Throwing rejects every job in the batch. */
  flush: (txs: T[]) => Promise<string>
  /** Structured telemetry hook. */
  onEvent?: (event: string, fields: Record<string, unknown>) => void
}

interface BatchItem<T> {
  tx: T
  resolve: (chainTxId: string) => void
  reject: (err: unknown) => void
}

export class RelayBatcher<T> {
  private buf: BatchItem<T>[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: RelayBatcherOptions<T>) {}

  /** Enqueue a proven tx; resolves with the shared chain tx id once its batch
   *  is submitted. */
  submit(tx: T): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.buf.push({ tx, resolve, reject })
      if (this.buf.length >= this.opts.maxBatch) {
        void this.flushNow()
      } else if (!this.timer) {
        this.timer = setTimeout(() => void this.flushNow(), this.opts.windowMs)
      }
    })
  }

  private async flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const batch = this.buf
    this.buf = []
    if (batch.length === 0) return

    const emit = this.opts.onEvent ?? (() => {})
    emit('relay.batch.flush', { size: batch.length })
    try {
      const chainTxId = await this.opts.flush(batch.map((b) => b.tx))
      emit('relay.batch.ok', { size: batch.length, chainTxId })
      for (const b of batch) b.resolve(chainTxId)
    } catch (e) {
      // A merged tx is atomic — one invalid member fails the whole submit. If
      // we just rejected the batch, every holder would retry and re-form a
      // batch that the same poison tx fails again → starvation. Instead bisect
      // to per-tx submits so the poison is isolated and the good txs still land.
      if (batch.length === 1) {
        emit('relay.batch.error', { size: 1, err: e instanceof Error ? e.message : String(e) })
        batch[0]!.reject(e)
        return
      }
      emit('relay.batch.bisect', {
        size: batch.length,
        err: e instanceof Error ? e.message : String(e),
      })
      await Promise.all(
        batch.map(async (b) => {
          try {
            b.resolve(await this.opts.flush([b.tx]))
          } catch (e2) {
            b.reject(e2)
          }
        }),
      )
    }
  }
}
