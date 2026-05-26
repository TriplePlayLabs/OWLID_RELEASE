/**
 * WebSocket lifecycle regressions for `usePresentation`.
 *
 * Background: prod accumulated `?role=holder` sockets in devtools —
 * one per modal open — because of three async-cleanup bugs (in-flight
 * createSession resolving post-unmount, finish path holding the
 * socket open for a 5 s grace window, stale-sessionId reuse). These
 * tests pin the fixes so any future drift surfaces here rather than
 * in browser devtools.
 *
 * The test mocks `@owlid/sdk` and `@owlid/verifier-client` so the
 * hook can run under jsdom without bringing the wallet, native-sdk
 * WASM, or the real verification-service into the suite.
 */
import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { act, renderHook, waitFor } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mock WebSocket — drives onopen / onclose / send under the test's control.
// ---------------------------------------------------------------------------

interface MockSocket {
  url: string
  readyState: number
  close: ReturnType<typeof mock>
  send: ReturnType<typeof mock>
  /** Optional close metadata captured from `ws.close(code, reason)`. */
  closeArgs: { code?: number; reason?: string } | null
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
  /** Force the socket open from the test (simulates server accept). */
  triggerOpen(): void
}

const openedSockets: MockSocket[] = []

class FakeWebSocket implements MockSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  url: string
  readyState = FakeWebSocket.CONNECTING
  closeArgs: { code?: number; reason?: string } | null = null
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null

  close = mock((code?: number, reason?: string) => {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.closeArgs = { code, reason }
    this.readyState = FakeWebSocket.CLOSED
  })
  send = mock((_data: string) => {})

  constructor(url: string) {
    this.url = url
    openedSockets.push(this)
  }

  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.({})
  }
}

// ---------------------------------------------------------------------------
// SDK + verifier-client mocks.
// ---------------------------------------------------------------------------

let pendingCreate: {
  resolve: (v: { sessionId: string }) => void
  reject: (e: unknown) => void
} | null = null

const createSession = mock((_req: unknown, _init?: { signal?: AbortSignal }) => {
  return new Promise<{ sessionId: string }>((resolve, reject) => {
    pendingCreate = { resolve, reject }
    _init?.signal?.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    })
  })
})

mock.module('@owlid/verifier-client', () => ({
  getPresentationApi: () => ({ createSession }),
}))

mock.module('@owlid/sdk', () => ({
  encodeSessionEngagement: (e: unknown) => JSON.stringify(e),
  getWsBaseUrl: () => 'ws://localhost:1234',
  matchDcqlAgainst: () => ({ entries: [], satisfiable: true, reason: undefined }),
  storage: { listCredentials: async () => [], loadWebAuthnCredential: async () => null },
  unwrapHolderKey: async () => 'deadbeef',
  // Real `OwlWallet.present` runs the full proving pipeline; in these
  // tests we only care that the hook tears the socket down BEFORE
  // and AFTER the wallet runs, so a stub vp_token is enough.
  OwlWallet: class {
    async present({ signal }: { signal?: AbortSignal }) {
      // Resolve immediately unless the caller aborts.
      if (signal?.aborted) throw new Error('aborted by signal')
      return {
        vpToken: { cred0: ['eyJ.eyJ.sig~D~'] },
        used: [{ dcqlId: 'cred0', credentialId: 'c', disclosures: [] }],
        attested: [],
      }
    }
  },
}))

// Mock crypto.subtle.digest — used by the hook's WS reconnect / setHash
// code paths in the SDK; harmless to stub for these tests.
if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
  ;(globalThis as { crypto: { subtle: unknown } }).crypto = {
    subtle: {
      digest: async () => new ArrayBuffer(32),
    },
  }
}

// Now that the modules are mocked, install the WebSocket stub and
// import the hook under test.
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket
const { usePresentation } = await import('../src/hooks/use-presentation')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  openedSockets.length = 0
  pendingCreate = null
  createSession.mockClear()
})

afterEach(() => {
  // Defensive — any test that left a pending promise should not bleed
  // into the next test.
  pendingCreate = null
})

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

describe('usePresentation WebSocket lifecycle', () => {
  test('opens exactly one WS after startPresentation', async () => {
    const { result } = renderHook(() => usePresentation())
    await act(async () => {
      void result.current.startPresentation()
      await flush()
    })
    expect(createSession).toHaveBeenCalledTimes(1)
    await act(async () => {
      pendingCreate?.resolve({ sessionId: 'session-A' })
      await flush()
    })
    expect(openedSockets).toHaveLength(1)
    expect(openedSockets[0]!.url).toContain('/ws/presentation/session-A')
  })

  test('unmount closes the open WS with code 1000', async () => {
    const { result, unmount } = renderHook(() => usePresentation())
    await act(async () => {
      void result.current.startPresentation()
      await flush()
      pendingCreate?.resolve({ sessionId: 'session-B' })
      await flush()
    })
    await act(async () => {
      openedSockets[0]!.triggerOpen()
      await flush()
    })
    expect(openedSockets[0]!.readyState).toBe(FakeWebSocket.OPEN)

    unmount()

    expect(openedSockets[0]!.close).toHaveBeenCalledTimes(1)
    expect(openedSockets[0]!.closeArgs?.code).toBe(1000)
    expect(openedSockets[0]!.readyState).toBe(FakeWebSocket.CLOSED)
  })

  test('fast unmount before createSession resolves opens NO socket', async () => {
    // Reproduces the prod leak: modal opens, user immediately
    // dismisses, the awaited POST settles after unmount. Without the
    // aliveRef + startAbortRef gate, the post-unmount continuation
    // calls connectWebSocket on a dead hook → orphan socket.
    const { result, unmount } = renderHook(() => usePresentation())
    await act(async () => {
      void result.current.startPresentation()
      await flush()
    })
    expect(createSession).toHaveBeenCalledTimes(1)

    unmount()

    // The (rejected) abort fires after unmount; the bug-mode would
    // also see a late resolve. Try both — neither should open a WS.
    await act(async () => {
      pendingCreate?.resolve({ sessionId: 'session-C' })
      await flush()
    })

    expect(openedSockets).toHaveLength(0)
  })

  test('cancel sends proof_failed AND closes the WS', async () => {
    const { result } = renderHook(() => usePresentation())
    await act(async () => {
      void result.current.startPresentation()
      await flush()
      pendingCreate?.resolve({ sessionId: 'session-D' })
      await flush()
    })
    await act(async () => {
      openedSockets[0]!.triggerOpen()
      await flush()
    })

    await act(async () => {
      result.current.cancel()
      await flush()
    })

    expect(openedSockets[0]!.send).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(openedSockets[0]!.send.mock.calls[0]![0] as string)
    expect(sent).toEqual({ type: 'proof_failed', payload: { code: 'proof_failed' } })
    expect(openedSockets[0]!.close).toHaveBeenCalled()
    expect(openedSockets[0]!.readyState).toBe(FakeWebSocket.CLOSED)
  })

  test('approve sends response AND closes the WS (no grace window)', async () => {
    const { result } = renderHook(() => usePresentation())
    await act(async () => {
      void result.current.startPresentation()
      await flush()
      pendingCreate?.resolve({ sessionId: 'session-E' })
      await flush()
    })
    await act(async () => {
      openedSockets[0]!.triggerOpen()
      await flush()
    })

    // Inject a DCQL request as if the verifier connected and sent it.
    await act(async () => {
      openedSockets[0]!.onmessage?.({
        data: JSON.stringify({
          type: 'request',
          payload: {
            sessionId: 'session-E',
            verifierName: 'Acme Bar',
            nonce: 'n0',
            dcql: { credentials: [] },
          },
        }),
      })
      await flush()
    })

    await act(async () => {
      await result.current.approve()
      await flush()
    })

    // Two sends: the verifier `request` was inbound so it doesn't
    // increment send; only the response goes outbound.
    const sends = openedSockets[0]!.send.mock.calls.map((c) => JSON.parse(c[0] as string))
    expect(sends.some((m) => m.type === 'response')).toBe(true)
    expect(openedSockets[0]!.close).toHaveBeenCalled()
    expect(openedSockets[0]!.readyState).toBe(FakeWebSocket.CLOSED)
    await waitFor(() => expect(result.current.state).toBe('complete'))
  })

  test('startPresentation called twice replaces the previous socket', async () => {
    // Guards the stale-sessionId short-circuit in connectWebSocket:
    // without the URL match check the second start would reuse the
    // first (OPEN) socket pointing at the previous session.
    const { result } = renderHook(() => usePresentation())
    await act(async () => {
      void result.current.startPresentation()
      await flush()
      pendingCreate?.resolve({ sessionId: 'session-F1' })
      await flush()
    })
    await act(async () => {
      openedSockets[0]!.triggerOpen()
      await flush()
    })

    await act(async () => {
      void result.current.startPresentation()
      await flush()
      pendingCreate?.resolve({ sessionId: 'session-F2' })
      await flush()
    })

    expect(openedSockets).toHaveLength(2)
    expect(openedSockets[0]!.close).toHaveBeenCalled()
    expect(openedSockets[0]!.readyState).toBe(FakeWebSocket.CLOSED)
    expect(openedSockets[1]!.url).toContain('/ws/presentation/session-F2')
  })
})
