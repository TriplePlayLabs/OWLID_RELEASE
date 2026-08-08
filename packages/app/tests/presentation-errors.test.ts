/**
 * Unit coverage for `formatPresentationError`. Pins the user-facing
 * categories the presentation modal renders — in particular the proving
 * wall-clock timeout (GH QA #2), which must read as a clear, retryable
 * "taking too long" rather than falling through to a generic failure.
 */
import { describe, expect, test, mock } from 'bun:test'

// `@owlid/sdk`'s `parseProofError` is the only import; stub it so the
// suite runs under bun without pulling the SDK barrel + Midnight WASM.
mock.module('@owlid/sdk', () => ({
  parseProofError: () => null,
}))

const { formatPresentationError } = await import('../src/lib/presentation-errors')

describe('formatPresentationError — proving timeout (#2)', () => {
  test('maps a "timed out" error to a clear, retryable timeout message', () => {
    const f = formatPresentationError(
      new Error(
        'Proof generation timed out — the proof server or Midnight network is taking too long.',
      ),
    )
    expect(f.title).toBe('Proof is taking too long')
    expect(f.retryable).toBe(true)
    expect(f.body.toLowerCase()).toContain('time limit')
    expect(f.hint?.toLowerCase()).toContain('proof server')
  })

  test('accepts a raw string (the hook sets `error` as a string)', () => {
    const f = formatPresentationError('request timed out')
    expect(f.title).toBe('Proof is taking too long')
    expect(f.retryable).toBe(true)
  })

  test('does not mistake an age-assert failure for a timeout', () => {
    const f = formatPresentationError(new Error('failed assert: age below threshold'))
    expect(f.title).not.toBe('Proof is taking too long')
    expect(f.retryable).toBe(false)
  })
})
