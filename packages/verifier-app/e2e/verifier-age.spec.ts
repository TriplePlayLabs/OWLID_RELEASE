import { test, expect } from '@playwright/test'

/**
 * GH #11 — verifier-supplied values must go on the wire as real numbers.
 *
 * The redesigned verifier is configure-first: the operator picks checks on
 * the home screen, scans the holder QR (fake camera), and the app auto-sends
 * the pre-built request once the server signals `session_ready` (which
 * carries the per-session nonce). This spec drives that full flow and asserts
 * the request frame carries a numeric age threshold (no "030"-style strings)
 * and the selected email check.
 */

const REGISTRY = [
  {
    id: 'age:gte',
    attribute: 'age',
    label: 'Over a minimum age',
    op: 'GreaterOrEqual',
    route: 'age_over',
    value: '18',
  },
  {
    id: 'age:range',
    attribute: 'age',
    label: 'Age in a set range',
    op: 'Range',
    route: 'age_range',
    value: '',
  },
  {
    id: 'email:verified',
    attribute: 'email',
    label: 'Email is verified',
    op: 'Equal',
    route: 'email_verified',
    value: 'true',
  },
]

// Fakes the holder side of the presentation WebSocket: opens immediately
// so the app advances scanning->connecting->waiting, and records everything
// the verifier sends so the test can inspect the request payload. Non
// presentation sockets (Vite HMR) fall through to the real implementation.
function installFakeWebSocket() {
  const Real = window.WebSocket
  const sent: string[] = []
  ;(window as unknown as { __WS_SENT__: string[] }).__WS_SENT__ = sent

  function FakeWS(this: Record<string, unknown>, url: string, protocols?: string | string[]) {
    if (!/presentation/.test(String(url))) {
      return new Real(url as string, protocols)
    }
    this.url = url
    this.readyState = 0
    this.onopen = null
    this.onmessage = null
    this.onerror = null
    this.onclose = null
    setTimeout(() => {
      this.readyState = 1
      ;(this.onopen as ((ev: unknown) => void) | null)?.({})
      // The server emits `session_ready` (carrying the per-session nonce)
      // once both peers are connected; the verifier sends its request only
      // AFTER this — never on raw socket open, which bound the holder's
      // KB-JWT to a stale nonce from a previous session.
      ;(this.onmessage as ((ev: { data: string }) => void) | null)?.({
        data: JSON.stringify({ type: 'session_ready', payload: { nonce: 'a'.repeat(32) } }),
      })
    }, 30)
  }
  FakeWS.prototype.send = function (data: string) {
    sent.push(String(data))
  }
  FakeWS.prototype.close = function (this: Record<string, unknown>) {
    this.readyState = 3
    ;(this.onclose as ((ev: unknown) => void) | null)?.({ code: 1000 })
  }
  FakeWS.prototype.addEventListener = function () {}
  FakeWS.prototype.removeEventListener = function () {}
  ;(FakeWS as unknown as Record<string, number>).CONNECTING = 0
  ;(FakeWS as unknown as Record<string, number>).OPEN = 1
  ;(FakeWS as unknown as Record<string, number>).CLOSING = 2
  ;(FakeWS as unknown as Record<string, number>).CLOSED = 3
  ;(window as unknown as { WebSocket: unknown }).WebSocket = FakeWS
}

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(['camera'])
  await page.addInitScript(installFakeWebSocket)

  // Backend mocks — health keeps the app online, predicates back the
  // configure-first catalog. page.route intercepts before the network,
  // so the verification host's origin doesn't matter.
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok' } }))
  await page.route('**/predicates', (route) => route.fulfill({ json: REGISTRY }))
})

test('configure-first flow sends numeric age threshold + selected email check (#11)', async ({
  page,
}) => {
  await page.goto('/')

  // Home: "Age 18 or older" is preselected (bar preset). Add the email check.
  await page.getByRole('button', { name: /verified email address/i }).click()

  // Continue stays disabled until the verifier sets its display name.
  await page.getByPlaceholder(/blue owl/i).fill('Test Verifier')

  await page.getByRole('button', { name: /continue to scan/i }).click()

  // Fake camera feeds the engagement QR -> zxing decodes it -> WS opens ->
  // the pre-built request is auto-sent and the app waits for the holder.
  // The decode takes a couple of seconds; toBeVisible polls.
  await expect(page.getByText(/waiting for approval/i)).toBeVisible()

  // The request the verifier put on the wire must carry a numeric
  // threshold (not a "030"-style string) and the email predicate.
  const sent = await page.evaluate(
    () => (window as unknown as { __WS_SENT__: string[] }).__WS_SENT__,
  )
  const request = sent.map((s) => JSON.parse(s)).find((m) => m.type === 'request')
  expect(request, 'verifier sent a request frame').toBeTruthy()
  const blob = JSON.stringify(request)
  expect(blob).toContain('"threshold":18')
  expect(blob).toContain('email_verified')
  expect(blob).not.toMatch(/"threshold":"/)
})
