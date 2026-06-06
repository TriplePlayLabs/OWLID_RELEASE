import { describe, expect, test } from 'bun:test'
import { isDustShortfallError } from '../src/dust-errors'

describe('isDustShortfallError', () => {
  test('matches the dust-balance failures (retryable)', () => {
    // The exact string seen in prod relay.background.error logs.
    expect(isDustShortfallError(new Error('Insufficient Funds: could not balance dust'))).toBe(true)
    expect(isDustShortfallError(new Error('could not balance dust'))).toBe(true)
    expect(isDustShortfallError('Wallet.InsufficientFunds')).toBe(true)
    expect(isDustShortfallError(new Error('INSUFFICIENT FUNDS'))).toBe(true) // case-insensitive
  })

  test('does NOT match terminal node/submit failures (must not retry)', () => {
    // The registerIdentity failure from the same incident — a node reject,
    // not a dust shortfall. Retrying it would repeat a doomed submit.
    expect(
      isDustShortfallError(new Error('RpcError: 1010: Invalid Transaction: Custom error: 170')),
    ).toBe(false)
    expect(isDustShortfallError(new Error('Transaction submission failed'))).toBe(false)
    expect(isDustShortfallError(new Error('something else'))).toBe(false)
  })

  test('handles non-Error inputs without throwing', () => {
    expect(isDustShortfallError(undefined)).toBe(false)
    expect(isDustShortfallError(null)).toBe(false)
    expect(isDustShortfallError({ message: 'could not balance dust' })).toBe(false) // not an Error, stringifies to [object Object]
  })
})
