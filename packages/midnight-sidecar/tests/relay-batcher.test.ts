import { describe, expect, test } from 'bun:test'
import { RelayBatcher } from '../src/relay-batcher'

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('RelayBatcher', () => {
  test('coalesces submits within the window into ONE flush', async () => {
    const flushes: number[][] = []
    const b = new RelayBatcher<number>({
      windowMs: 50,
      maxBatch: 100,
      flush: async (txs) => {
        flushes.push(txs)
        return `chain-${flushes.length}`
      },
    })
    const ps = [b.submit(1), b.submit(2), b.submit(3)]
    const ids = await Promise.all(ps)
    expect(flushes).toEqual([[1, 2, 3]]) // one batch
    expect(ids).toEqual(['chain-1', 'chain-1', 'chain-1']) // shared chain id
  })

  test('flushes immediately at maxBatch without waiting the window', async () => {
    const flushes: number[][] = []
    const b = new RelayBatcher<number>({
      windowMs: 10_000, // long — must NOT be what triggers the flush
      maxBatch: 2,
      flush: async (txs) => {
        flushes.push(txs)
        return 'c'
      },
    })
    const p1 = b.submit(1)
    const p2 = b.submit(2) // hits maxBatch=2 → immediate flush
    await Promise.all([p1, p2])
    expect(flushes).toEqual([[1, 2]])
  })

  test('separate windows produce separate batches', async () => {
    const flushes: number[][] = []
    const b = new RelayBatcher<number>({
      windowMs: 30,
      maxBatch: 100,
      flush: async (txs) => {
        flushes.push(txs)
        return 'c'
      },
    })
    await b.submit(1)
    await b.submit(2)
    expect(flushes).toEqual([[1], [2]]) // each awaited submit drained its own batch
  })

  test('a flush that fails for ALL (even individually) rejects every job', async () => {
    const b = new RelayBatcher<number>({
      windowMs: 20,
      maxBatch: 100,
      flush: async () => {
        throw new Error('merge/submit failed')
      },
    })
    const results = await Promise.allSettled([b.submit(1), b.submit(2)])
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
  })

  test('one poison tx is isolated by bisect — good txs still land', async () => {
    const POISON = 666
    let flushCalls = 0
    const b = new RelayBatcher<number>({
      windowMs: 20,
      maxBatch: 100,
      // Any submit (batched or single) containing the poison fails; everything
      // else succeeds. The merged batch fails → bisect → only POISON rejects.
      flush: async (txs) => {
        flushCalls++
        if (txs.includes(POISON)) throw new Error('invalid member')
        return `chain-${flushCalls}`
      },
    })
    const results = await Promise.allSettled([b.submit(1), b.submit(POISON), b.submit(3)])
    expect(results[0]!.status).toBe('fulfilled') // good
    expect(results[1]!.status).toBe('rejected') // poison
    expect(results[2]!.status).toBe('fulfilled') // good
    // 1 batched flush (failed) + 3 individual bisect flushes.
    expect(flushCalls).toBe(4)
  })

  test('emits batch telemetry with size', async () => {
    const events: Array<{ event: string; size?: number }> = []
    const b = new RelayBatcher<number>({
      windowMs: 20,
      maxBatch: 100,
      flush: async () => 'c',
      onEvent: (event, fields) => events.push({ event, size: fields.size as number }),
    })
    await Promise.all([b.submit(1), b.submit(2)])
    const flush = events.find((e) => e.event === 'relay.batch.flush')
    expect(flush?.size).toBe(2)
    expect(events.some((e) => e.event === 'relay.batch.ok')).toBe(true)
    await tick(1)
  })
})
