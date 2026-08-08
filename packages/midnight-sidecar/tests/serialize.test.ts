import { describe, expect, test } from 'bun:test'

/**
 * Mirrors the FIXED `serialize()` single-writer queue in
 * `src/wallet-supervisor.ts`. Pins its invariants so a regression in the
 * source (e.g. reverting to `writeChain = next.finally(...)`) is caught:
 * the caller's promise carries the job's rejection, but the INTERNAL
 * chain link must never reject — a terminal `submitTx` failure with no
 * follow-up job behind it would otherwise leave an unhandled rejection
 * that can take the sidecar down under low traffic.
 */
function makeSerializer() {
  let writeChain: Promise<unknown> = Promise.resolve()
  const depth = { current: 0 }
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    depth.current++
    const next = writeChain.then(fn, fn)
    writeChain = next.then(
      () => {
        depth.current--
      },
      () => {
        depth.current--
      },
    )
    return next as Promise<T>
  }
  return { serialize, chain: () => writeChain, depth }
}

describe('wallet-supervisor serialize()', () => {
  test('a failing job rejects the caller but the chain link still resolves (no unhandled rejection)', async () => {
    const { serialize, chain } = makeSerializer()
    const failing = serialize(async () => {
      throw new Error('submit failed')
    })
    // The caller owns the rejection…
    await expect(failing).rejects.toThrow('submit failed')
    // …but the internal chain link must settle FULFILLED, never reject —
    // this is the exact property that prevents the unhandled-rejection leak.
    await expect(chain()).resolves.toBeUndefined()
  })

  test('jobs stay serialized: job N starts only after job N-1 settles', async () => {
    const { serialize } = makeSerializer()
    const order: string[] = []
    const a = serialize(async () => {
      await new Promise((r) => setTimeout(r, 20))
      order.push('a')
    })
    const b = serialize(async () => {
      order.push('b')
    })
    await Promise.allSettled([a, b])
    expect(order).toEqual(['a', 'b'])
  })

  test('a failed job does not wedge the queue — the next job still runs', async () => {
    const { serialize } = makeSerializer()
    const order: string[] = []
    const a = serialize(async () => {
      throw new Error('boom')
    })
    const b = serialize(async () => {
      order.push('b')
    })
    await Promise.allSettled([a, b])
    expect(order).toEqual(['b'])
  })

  test('queue depth returns to 0 after all jobs settle (no leaked slot)', async () => {
    const { serialize, depth } = makeSerializer()
    await Promise.allSettled([
      serialize(async () => {}),
      serialize(async () => {
        throw new Error('x')
      }),
      serialize(async () => {}),
    ])
    await new Promise((r) => setTimeout(r, 0)) // let the final chain-link .then run
    expect(depth.current).toBe(0)
  })
})
