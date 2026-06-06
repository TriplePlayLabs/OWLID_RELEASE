/**
 * Regression for GH #14 — "service shows repeatedly as going offline".
 *
 * The verifier banner used to flip offline on a single failed `/health`
 * fetch. These pin the debounce: a transient blip is retried within a tick
 * and a single failing check never flips the banner; only consecutive
 * failures past the threshold do, and recovery is immediate.
 */
import { describe, expect, test } from 'bun:test'
import { checkHealthWithRetry, decideServiceOnline } from '../src/health-monitor'

describe('checkHealthWithRetry (#14)', () => {
  test('a transient failure followed by success resolves healthy', async () => {
    let calls = 0
    const ok = await checkHealthWithRetry(
      async () => {
        calls++
        return calls >= 2
      },
      2,
      0,
    )
    expect(ok).toBe(true)
    expect(calls).toBe(2)
  })

  test('all attempts failing resolves unhealthy', async () => {
    let calls = 0
    const ok = await checkHealthWithRetry(
      async () => {
        calls++
        return false
      },
      2,
      0,
    )
    expect(ok).toBe(false)
    expect(calls).toBe(2)
  })

  test('a throwing check counts as a failed attempt, not a crash', async () => {
    const ok = await checkHealthWithRetry(
      async () => {
        throw new Error('Failed to fetch')
      },
      2,
      0,
    )
    expect(ok).toBe(false)
  })
})

describe('decideServiceOnline (#14)', () => {
  test('healthy is trusted immediately', () => {
    expect(decideServiceOnline(false, true, 0)).toBe(true)
    expect(decideServiceOnline(null, true, 0)).toBe(true)
  })

  test('one failing check does NOT flip an online banner offline', () => {
    expect(decideServiceOnline(true, false, 1)).toBe(true)
  })

  test('reaching the failure threshold flips offline', () => {
    expect(decideServiceOnline(true, false, 2)).toBe(false)
  })

  test('a single failure at startup stays in the unknown/checking state', () => {
    expect(decideServiceOnline(null, false, 1)).toBe(null)
  })
})
