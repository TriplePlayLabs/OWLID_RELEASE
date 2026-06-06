import { test, expect } from '@playwright/test'

/**
 * GH #11 — "Age within range isn't a proper number field, it should just
 * say 30 not 030".
 *
 * Full user flow against the running dev server: the verifier scans a
 * holder QR (fake camera), the WebSocket handshake lands it on the
 * predicate picker, then the operator types an age range. We assert the
 * field never keeps a leading zero AND that the request put on the wire
 * carries real numbers (not "030").
 *
 * Everything the backend would serve is network-mocked; the holder side
 * of the WebSocket is faked in-page.
 */

const REGISTRY = [
  {
    id: 'age:range',
    attribute: 'age',
    label: 'Age is within a range',
    op: 'Range',
    route: 'age_range',
    value: '',
  },
  {
    id: 'age:gte',
    attribute: 'age',
    label: 'Is over a minimum age',
    op: 'GreaterOrEqual',
    route: 'age_over',
    value: '18',
  },
]

// Fakes the holder side of the presentation WebSocket: opens immediately
// so the app advances idle->connecting->selecting, and records everything
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

  // Backend mocks — health keeps the "Scan QR" button enabled, predicates
  // populate the picker. Same-origin (see config), so no CORS dance.
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok' } }))
  await page.route('**/predicates', (route) => route.fulfill({ json: REGISTRY }))
})

async function reachPredicatePicker(page: import('@playwright/test').Page) {
  await page.goto('/')
  const scan = page.getByRole('button', { name: /scan qr/i })
  await expect(scan).toBeEnabled() // waits for the mocked health check
  await scan.click()
  // Fake camera feeds the engagement QR -> zxing decodes it -> WS opens ->
  // predicate picker. The decode takes a couple of seconds; toBeVisible polls.
  await expect(page.getByText('What do you need to check?')).toBeVisible()
}

test('age range field shows "30" not "030", and sends numeric min/max (#11)', async ({ page }) => {
  await reachPredicatePicker(page)

  await page.getByText('Age is within a range').click()
  const min = page.locator('#age-min')
  const max = page.locator('#age-max')

  await min.fill('')
  await min.pressSequentially('030')
  await expect(min).toHaveValue('30')

  await max.fill('')
  await max.pressSequentially('45')
  await expect(max).toHaveValue('45')

  await page.getByRole('button', { name: /send request/i }).click()

  // The request the verifier put on the wire must carry numbers, not "030".
  const sent = await page.evaluate(
    () => (window as unknown as { __WS_SENT__: string[] }).__WS_SENT__,
  )
  const request = sent.map((s) => JSON.parse(s)).find((m) => m.type === 'request')
  expect(request, 'verifier sent a request frame').toBeTruthy()
  const blob = JSON.stringify(request)
  expect(blob).toContain('"min":30')
  expect(blob).toContain('"max":45')
  expect(blob).not.toContain('030')
})

test('age threshold field shows "21" not "021" (#11)', async ({ page }) => {
  await reachPredicatePicker(page)

  await page.getByText('Is over a minimum age').click()
  const threshold = page.locator('#age-threshold')
  await threshold.fill('')
  await threshold.pressSequentially('021')
  await expect(threshold).toHaveValue('21')
})
