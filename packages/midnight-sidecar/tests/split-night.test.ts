import { describe, expect, test } from 'bun:test'
import { splitOutputs } from '../src/wallet'

describe('splitOutputs', () => {
  test('produces exactly `lanes` outputs that sum to the total', () => {
    const total = 50_000n * 10n ** 6n
    const out = splitOutputs(total, 8)
    expect(out).toHaveLength(8)
    expect(out.reduce((a, b) => a + b, 0n)).toBe(total)
  })

  test('first lanes-1 are equal; the last carries the remainder', () => {
    const out = splitOutputs(100n, 8) // 100/8 = 12 r4
    expect(out.slice(0, 7)).toEqual(Array(7).fill(12n))
    expect(out[7]).toBe(100n - 12n * 7n) // 16
    expect(out.reduce((a, b) => a + b, 0n)).toBe(100n)
  })

  test('exact division leaves equal lanes', () => {
    expect(splitOutputs(80n, 8)).toEqual(Array(8).fill(10n))
  })

  test('rejects invalid inputs', () => {
    expect(() => splitOutputs(100n, 0)).toThrow(/lanes/)
    expect(() => splitOutputs(0n, 8)).toThrow(/nothing to split/)
    expect(() => splitOutputs(4n, 8)).toThrow(/too small/) // 4/8 = 0 per lane
  })
})
