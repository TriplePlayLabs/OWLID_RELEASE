import { describe, expect, test } from 'bun:test'
import { createSubmitPipeline, type SubmitPipelineDeps } from '../src/submit-pipeline'

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

// Mirror of the supervisor's tail-chained single-writer serializer.
function makeSerialize() {
  let chain: Promise<unknown> = Promise.resolve()
  let calls = 0
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    calls += 1
    const next = chain.then(fn, fn)
    chain = next.then(
      () => {},
      () => {},
    )
    return next as Promise<T>
  }
  return { serialize, calls: () => calls }
}

async function waitUntil(pred: () => boolean, timeoutMs = 1000) {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out')
    await tick(2)
  }
}

function baseDeps(overrides: Partial<SubmitPipelineDeps> = {}): SubmitPipelineDeps {
  return {
    ensureReady: async () => {},
    balanceTx: async (tx) => ({ tx }),
    reserve: async () => {},
    broadcast: async () => 'txid',
    revert: async () => {},
    reapStalePending: async () => {},
    serialize: makeSerialize().serialize,
    dustRetryWaitMs: 0,
    sleep: async () => {},
    ...overrides,
  }
}

describe('createSubmitPipeline — concurrency contract', () => {
  test('balance+reserve serialize, but broadcasts overlap (pipelined)', async () => {
    let phase1Active = 0
    let phase1Max = 0
    let broadcastActive = 0
    let broadcastMax = 0
    const releases: Array<() => void> = []

    const { serialize } = makeSerialize()
    const submit = createSubmitPipeline(
      baseDeps({
        serialize,
        balanceTx: async (tx) => {
          phase1Active += 1
          phase1Max = Math.max(phase1Max, phase1Active)
          await tick()
          return { tx }
        },
        reserve: async () => {
          await tick()
          phase1Active -= 1 // phase 1 = balanceTx → reserve, must never overlap
        },
        broadcast: async () => {
          broadcastActive += 1
          broadcastMax = Math.max(broadcastMax, broadcastActive)
          await new Promise<void>((r) => releases.push(r)) // hold both broadcasts open
          broadcastActive -= 1
          return 'txid'
        },
      }),
    )

    const p1 = submit('a')
    const p2 = submit('b')

    // Both submits should reach broadcast concurrently — proving the lock was
    // released after reserve, not held through the network leg.
    await waitUntil(() => broadcastActive === 2)
    expect(broadcastMax).toBe(2) // broadcasts pipelined
    expect(phase1Max).toBe(1) // balance+reserve never overlapped

    releases.forEach((r) => r())
    await Promise.all([p1, p2])
  })
})

describe('createSubmitPipeline — dust retry', () => {
  test('retries balance+reserve once after reaping on a dust shortfall', async () => {
    let balanceCalls = 0
    let reaped = 0
    let slept = 0
    const submit = createSubmitPipeline(
      baseDeps({
        balanceTx: async () => {
          balanceCalls += 1
          if (balanceCalls === 1) throw new Error('Insufficient Funds: could not balance dust')
          return { ok: true }
        },
        reapStalePending: async () => {
          reaped += 1
        },
        sleep: async () => {
          slept += 1
        },
      }),
    )

    const out = await submit('x')
    expect(out).toBe('txid')
    expect(balanceCalls).toBe(2)
    expect(reaped).toBe(1)
    expect(slept).toBe(1)
  })

  test('retries up to dustRetryAttempts when the shortfall persists', async () => {
    let balanceCalls = 0
    let reaped = 0
    const submit = createSubmitPipeline(
      baseDeps({
        dustRetryAttempts: 3,
        // Shortfall on the first 2 balances (hostage pending not yet reaped),
        // succeeds on the 3rd — an actively-tested wallet with several dropped
        // txs needs more than one retry.
        balanceTx: async () => {
          balanceCalls += 1
          if (balanceCalls < 3) throw new Error('Insufficient Funds: could not balance dust')
          return { ok: true }
        },
        reapStalePending: async () => {
          reaped += 1
        },
      }),
    )

    const out = await submit('x')
    expect(out).toBe('txid')
    expect(balanceCalls).toBe(3)
    expect(reaped).toBe(2)
  })

  test('reaps with the short shortfall grace, not the periodic grace', async () => {
    let graceSeen: number | undefined = -1
    const submit = createSubmitPipeline(
      baseDeps({
        dustShortfallReapGraceMs: 90_000,
        balanceTx: (() => {
          let n = 0
          return async () => {
            n += 1
            if (n === 1) throw new Error('Insufficient Funds: could not balance dust')
            return { ok: true }
          }
        })(),
        reapStalePending: async (g) => {
          graceSeen = g
        },
      }),
    )

    await submit('x')
    expect(graceSeen).toBe(90_000)
  })

  test('gives up after exhausting retries on a persistent shortfall', async () => {
    let balanceCalls = 0
    const submit = createSubmitPipeline(
      baseDeps({
        dustRetryAttempts: 2,
        balanceTx: async () => {
          balanceCalls += 1
          throw new Error('Insufficient Funds: could not balance dust')
        },
      }),
    )

    await expect(submit('x')).rejects.toThrow(/could not balance dust/)
    expect(balanceCalls).toBe(3) // initial + 2 retries
  })

  test('does NOT retry a non-dust balance failure', async () => {
    let balanceCalls = 0
    let reserved = 0
    let reaped = 0
    const submit = createSubmitPipeline(
      baseDeps({
        balanceTx: async () => {
          balanceCalls += 1
          throw new Error('RpcError: 1010: Invalid Transaction: Custom error: 170')
        },
        reserve: async () => {
          reserved += 1
        },
        reapStalePending: async () => {
          reaped += 1
        },
      }),
    )

    await expect(submit('x')).rejects.toThrow('Custom error: 170')
    expect(balanceCalls).toBe(1) // no retry
    expect(reserved).toBe(0) // never reserved
    expect(reaped).toBe(0) // no reap
  })
})

describe('createSubmitPipeline — broadcast failure', () => {
  test('reverts under the serializer and rethrows', async () => {
    let reverted = 0
    const s = makeSerialize()
    const submit = createSubmitPipeline(
      baseDeps({
        serialize: s.serialize,
        broadcast: async () => {
          throw new Error('node rejected')
        },
        revert: async () => {
          reverted += 1
        },
      }),
    )

    await expect(submit('x')).rejects.toThrow('node rejected')
    expect(reverted).toBe(1)
    // Two serialized sections: phase-1 balance+reserve, then the revert.
    expect(s.calls()).toBe(2)
  })
})

// Models the wallet's real disjoint-selection mechanism: chooseCoin picks the
// smallest AVAILABLE dust UTXO; reserve() moves it into pendingDust (removes it
// from availableCoins); the pipeline runs balance+reserve inside the serializer.
// Proves the "no orchestrator change needed" claim — concurrency comes from K
// dust UTXOs + reservation, not custom coin selection.
describe('createSubmitPipeline — disjoint dust UTXO selection', () => {
  function lanePipeline(utxos: number[]) {
    const available = new Set(utxos)
    const picked: number[] = []
    const { serialize } = makeSerialize()
    const submit = createSubmitPipeline(
      baseDeps({
        serialize,
        // chooseCoin: smallest available, or a dust shortfall when none free.
        balanceTx: async () => {
          if (available.size === 0) throw new Error('Insufficient Funds: could not balance dust')
          return { utxo: Math.min(...available) }
        },
        // reserve == addPendingTransaction: drop the picked UTXO from available.
        reserve: async (balanced) => {
          const u = (balanced as { utxo: number }).utxo
          if (!available.has(u)) throw new Error(`double-picked UTXO ${u}`)
          available.delete(u)
          picked.push(u)
        },
      }),
    )
    return { submit, picked }
  }

  test('8 concurrent submits draw 8 distinct dust UTXOs (no double-pick)', async () => {
    const { submit, picked } = lanePipeline([1, 2, 3, 4, 5, 6, 7, 8])
    const results = await Promise.all(Array.from({ length: 8 }, () => submit('x')))
    expect(results).toEqual(Array(8).fill('txid'))
    expect([...picked].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  test('a single dust UTXO bottlenecks the 2nd concurrent submit (the pre-split state)', async () => {
    const { submit } = lanePipeline([1])
    const results = await Promise.allSettled([submit('a'), submit('b')])
    const ok = results.filter((r) => r.status === 'fulfilled').length
    const short = results.filter(
      (r) => r.status === 'rejected' && /could not balance dust/.test(String(r.reason)),
    ).length
    expect(ok).toBe(1)
    expect(short).toBe(1)
  })
})
