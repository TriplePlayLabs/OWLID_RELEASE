/**
 * Regression for QA #3 — "Wallet unlock has no timeout or error state".
 * A failed/stalled passkey ceremony must NOT leave the unlock button
 * spinning forever: the hook has to drop `isUnlocking` back to false so
 * the button re-enables (retry path) and the wallet stays locked.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createElement } from 'react'

let sessionActive = false
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

mock.module('~/lib/wallet-session', () => ({
  subscribeWalletSession: (cb: () => void) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  hasWalletSession: () => sessionActive,
  isAutoLockSuspended: () => false,
  refreshWalletSession: () => {},
  startWalletSession: () => {
    sessionActive = true
    notify()
  },
  endWalletSession: () => {
    sessionActive = false
    notify()
  },
  walletSessionMsRemaining: () => 60_000,
}))

mock.module('~/hooks/use-identity', () => ({
  useIdentity: () => ({ credentialId: 'pk-1' }),
}))

let authImpl: () => Promise<unknown> = () => Promise.resolve({})
mock.module('~/hooks/use-webauthn', () => ({
  useWebAuthn: () => ({ authenticate: () => authImpl() }),
}))

const { useWalletSession } = await import('../src/hooks/use-wallet-session')

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

beforeEach(() => {
  sessionActive = false
  authImpl = () => Promise.resolve({})
})

describe('useWalletSession.unlock (#3)', () => {
  test('failed unlock re-enables the button and stays locked (retry path)', async () => {
    authImpl = () => Promise.reject(new Error('Passkey unlock timed out. Tap Unlock to try again.'))
    const { result } = renderHook(() => useWalletSession(true), { wrapper })

    expect(result.current.isLocked).toBe(true)

    await act(async () => {
      await expect(result.current.unlock()).rejects.toThrow(/timed out/i)
    })

    // The button must not be stuck spinning — retry is possible.
    expect(result.current.isUnlocking).toBe(false)
    expect(result.current.isLocked).toBe(true)
  })

  test('successful unlock opens the session and clears the spinner', async () => {
    authImpl = () => Promise.resolve({})
    const { result } = renderHook(() => useWalletSession(true), { wrapper })

    await act(async () => {
      await result.current.unlock()
    })

    await waitFor(() => expect(result.current.isLocked).toBe(false))
    expect(result.current.isUnlocking).toBe(false)
  })
})
