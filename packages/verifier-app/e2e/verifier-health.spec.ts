import { test, expect } from '@playwright/test'

/**
 * GH #14 — "service shows repeatedly as going offline".
 *
 * Real flow against the dev server: when `/health` blips, the verifier must
 * NOT flip the nav status pill to "Offline" on a single failed check. We mock
 * `/health` to fail and assert the debounced pill stays quiet; then we let it
 * succeed and assert the app is online and the configure-first flow advances
 * to the scan step.
 */

test('a single failed health check does NOT flip the status pill offline (#14)', async ({
  page,
}) => {
  // Every /health attempt this load fails (503). With the debounce
  // (offline only after 2 consecutive failing ticks), the first failing
  // tick must keep the pill in its last known state — not "Offline".
  await page.route('**/health', (route) => route.fulfill({ status: 503, json: { status: 'down' } }))

  await page.goto('/')

  // Give the first tick (with its in-tick retry) time to resolve...
  await page.waitForTimeout(3000)

  // ...the status pill must not read "Offline" after a single blip.
  await expect(page.locator('.nav-status')).not.toContainText(/offline/i)
})

test('a healthy service shows Online and Continue reaches the scan step (#14)', async ({
  page,
}) => {
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok' } }))
  await page.route('**/predicates', (route) => route.fulfill({ json: [] }))

  await page.goto('/')

  await expect(page.locator('.nav-status')).toContainText(/online/i)

  // Online → the offline gate must not block the configure-first flow.
  // Continue stays disabled until the verifier sets its display name.
  await page.getByPlaceholder(/blue owl/i).fill('Test Verifier')
  await page.getByRole('button', { name: /continue to scan/i }).click()
  await expect(page.getByText(/scan the holder's wallet/i)).toBeVisible()
})
