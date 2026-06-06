import { test, expect } from '@playwright/test'

/**
 * GH #14 — "service shows repeatedly as going offline".
 *
 * Real flow against the dev server: when `/health` blips, the verifier must
 * NOT flash the "offline" banner on a single failed check. We mock `/health`
 * to fail and assert the debounced banner stays quiet; then we let it succeed
 * and assert the app comes online (Scan QR enabled).
 */

const OFFLINE_TEXT = /verification service is offline/i

test('a single failed health check does NOT show the offline banner (#14)', async ({ page }) => {
  // Every /health attempt this load fails (503). With the debounce, one
  // failing check stays in the "checking" state — it must not flip offline.
  await page.route('**/health', (route) => route.fulfill({ status: 503, json: { status: 'down' } }))

  await page.goto('/')

  // Give the first tick (with its in-tick retry) time to resolve...
  await page.waitForTimeout(3000)

  // ...the offline banner must be absent, and Scan QR not yet enabled
  // (we're "checking", not "offline" and not "online").
  await expect(page.getByText(OFFLINE_TEXT)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /scan qr/i })).toBeDisabled()
})

test('a healthy service comes online and enables Scan QR (#14)', async ({ page }) => {
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok' } }))

  await page.goto('/')

  await expect(page.getByRole('button', { name: /scan qr/i })).toBeEnabled()
  await expect(page.getByText(OFFLINE_TEXT)).toHaveCount(0)
})
