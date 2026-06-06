import { beforeEach, describe, expect, test } from 'bun:test'
import {
  beginVerificationSession,
  endWalletSession,
  hasWalletSession,
  isAutoLockSuspended,
  isPasskeyCeremonyActive,
  isVerificationSessionActive,
  refreshWalletSession,
  startWalletSession,
  walletSessionMsRemaining,
  withPasskeyCeremony,
} from '../src/lib/wallet-session'

describe('wallet session', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  test('starts and ends a session', () => {
    startWalletSession(10_000)

    expect(hasWalletSession()).toBe(true)
    expect(walletSessionMsRemaining()).toBeGreaterThan(0)

    endWalletSession()

    expect(hasWalletSession()).toBe(false)
  })

  test('expires stale sessions and removes them from storage', () => {
    startWalletSession(-1)

    expect(hasWalletSession()).toBe(false)
    expect(walletSessionMsRemaining()).toBe(0)
  })

  test('refresh only extends an active session', () => {
    refreshWalletSession(10_000)
    expect(hasWalletSession()).toBe(false)

    startWalletSession(1_000)
    refreshWalletSession(10_000)

    expect(hasWalletSession()).toBe(true)
    expect(walletSessionMsRemaining()).toBeGreaterThan(1_000)
  })
})

describe('auto-lock suspension', () => {
  test('passkey ceremony suspends auto-lock for its duration only', async () => {
    expect(isAutoLockSuspended()).toBe(false)

    await withPasskeyCeremony(async () => {
      expect(isPasskeyCeremonyActive()).toBe(true)
      expect(isAutoLockSuspended()).toBe(true)
    })

    expect(isPasskeyCeremonyActive()).toBe(false)
    expect(isAutoLockSuspended()).toBe(false)
  })

  test('ceremony depth unwinds even when the body throws', async () => {
    await expect(
      withPasskeyCeremony(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(isPasskeyCeremonyActive()).toBe(false)
  })

  test('verification session suspends until released, idempotently', () => {
    const release = beginVerificationSession()
    expect(isVerificationSessionActive()).toBe(true)
    expect(isAutoLockSuspended()).toBe(true)

    release()
    expect(isVerificationSessionActive()).toBe(false)
    // Double release must not drive the counter negative.
    release()
    expect(isVerificationSessionActive()).toBe(false)
  })

  test('nested suspensions require all releases', () => {
    const a = beginVerificationSession()
    const b = beginVerificationSession()
    a()
    expect(isVerificationSessionActive()).toBe(true)
    b()
    expect(isVerificationSessionActive()).toBe(false)
  })
})
