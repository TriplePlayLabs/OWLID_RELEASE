/**
 * Phone regression: with 2+ cards the stack's sticky-:hover push-down
 * (translateY(4rem) on following items) landed on top of the Present
 * button on iOS. Hover effects are now gated behind
 * `@media (hover: hover)`; on a touch device the stack must never
 * cover the button. Playwright's click() enforces the hit target, so
 * an overlapping card fails this test.
 *
 * Live-stack gated like the other live specs.
 */
import { test, expect, devices } from '@playwright/test'
import { addVirtualAuthenticator } from './webauthn'

test.skip(!process.env.OWLID_LIVE_E2E, 'needs the full local stack (just dev-full)')

test.use({ ...devices['iPhone 13'], defaultBrowserType: 'chromium' })

test('present button stays clickable under a 2-card stack on touch', async ({ page }) => {
  test.setTimeout(300_000)
  await addVirtualAuthenticator(page)

  await page.goto('/register')
  const input = page.getByLabel('Username')
  const submit = page.getByRole('button', { name: /create account/i })
  await expect(async () => {
    await input.fill('stack-e2e')
    await expect(submit).toBeEnabled({ timeout: 1000 })
  }).toPass()
  await submit.click()
  await expect(page).toHaveURL(/\/login/)
  await page.getByRole('button', { name: /sign in with passkey/i }).click()

  await page.waitForURL(/add-provider/, { timeout: 30_000 })
  await page
    .getByText(/mock digid/i)
    .first()
    .click()
  await page.waitForURL(/wallet/, { timeout: 120_000 })

  await page.getByTestId('button-add-provider').click()
  await page
    .getByText(/mock bankid/i)
    .first()
    .click()
  await page.waitForURL(/wallet/, { timeout: 120_000 })

  await expect(page.getByText('2 cards')).toBeVisible()
  await page.screenshot({ path: 'test-results/stack-closed.png', fullPage: true })

  // Tap a card (this is what used to stick :hover and shift the stack),
  // close it again, then the button must be a clean hit target.
  const present = page.getByTestId('button-present-id')
  await expect(present).toBeEnabled()
  await present.click({ trial: true }) // hit-target check only — fails if covered

  // Open the top card, screenshot the expanded state, close it.
  await page.locator('.card-stack__item').last().click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'test-results/stack-open.png', fullPage: true })
  await page.locator('.card-stack__item--open .card-book').first().click()
  await page.waitForTimeout(600)
  await present.click({ trial: true })
})
