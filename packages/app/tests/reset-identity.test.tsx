/**
 * GH #16 — "Reset & clear identity: does this also revoke the identity on
 * chain?". Answer: by default NO (local device wipe), and OPT-IN yes via a
 * holder proof-of-possession self-revocation.
 *
 * These tests pin both halves:
 *   1. resetDemo is a local wipe (storage.clearAll) and nothing else.
 *   2. The reset dialog only revokes on-chain when the box is checked, and
 *      always revokes BEFORE wiping.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { createElement } from 'react'

const clearAll = mock(() => Promise.resolve())
mock.module('@owlid/sdk', () => ({
  storage: {
    clearAll,
    loadUsername: () => Promise.resolve('alice'),
    hasAnyCredential: () => Promise.resolve(true),
    loadWebAuthnCredential: () => Promise.resolve({ credentialId: 'pk-1' }),
  },
}))

// Stub the revoke layer — RTL only asserts the dialog calls it (or not).
const revokeAllCredentials = mock(() => Promise.resolve(['cred-A']))
mock.module('~/hooks/use-revoke', () => ({ revokeAllCredentials }))

const { useIdentity } = await import('../src/hooks/use-identity')
const { ResetIdentityDialog } = await import('../src/components/identity/ResetIdentityDialog')

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

beforeEach(() => {
  clearAll.mockClear()
  revokeAllCredentials.mockClear()
  cleanup()
})

describe('resetDemo (#16)', () => {
  test('wipes local storage only — no on-chain revoke call', async () => {
    const { result } = renderHook(() => useIdentity(), { wrapper })
    await waitFor(() => expect(result.current.isBootstrapping).toBe(false))
    await act(async () => {
      try {
        await result.current.resetDemo()
      } catch {
        /* jsdom reload throws; clearAll already ran — that's the point. */
      }
    })
    expect(clearAll).toHaveBeenCalledTimes(1)
    expect(revokeAllCredentials).not.toHaveBeenCalled()
  })
})

describe('ResetIdentityDialog (#16)', () => {
  test('default (box unchecked): wipes without revoking', async () => {
    const onWipe = mock(() => {})
    render(<ResetIdentityDialog open onOpenChange={() => {}} onWipe={onWipe} />)

    fireEvent.click(screen.getByRole('button', { name: /wipe this device/i }))
    await waitFor(() => expect(onWipe).toHaveBeenCalledTimes(1))
    expect(revokeAllCredentials).not.toHaveBeenCalled()
  })

  test('box checked: revokes on-chain BEFORE wiping', async () => {
    const calls: string[] = []
    revokeAllCredentials.mockImplementation(async () => {
      calls.push('revoke')
      return ['cred-A']
    })
    const onWipe = mock(() => {
      calls.push('wipe')
    })
    render(<ResetIdentityDialog open onOpenChange={() => {}} onWipe={onWipe} />)

    fireEvent.click(screen.getByRole('checkbox', { name: /revoke my id on the network/i }))
    fireEvent.click(screen.getByRole('button', { name: /revoke & wipe/i }))

    await waitFor(() => expect(onWipe).toHaveBeenCalledTimes(1))
    expect(revokeAllCredentials).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['revoke', 'wipe']) // revoke strictly before wipe
  })

  test('revoke failure aborts the wipe', async () => {
    revokeAllCredentials.mockImplementation(() => Promise.reject(new Error('chain down')))
    const onWipe = mock(() => {})
    render(<ResetIdentityDialog open onOpenChange={() => {}} onWipe={onWipe} />)

    fireEvent.click(screen.getByRole('checkbox', { name: /revoke my id on the network/i }))
    fireEvent.click(screen.getByRole('button', { name: /revoke & wipe/i }))

    await waitFor(() => expect(revokeAllCredentials).toHaveBeenCalled())
    expect(onWipe).not.toHaveBeenCalled() // credential not revoked → don't wipe
  })
})
