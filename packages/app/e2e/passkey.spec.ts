import { test, expect, type Page } from '@playwright/test'
import { addVirtualAuthenticator } from './webauthn'

/**
 * Passkey e2e: a real WebAuthn register -> sign-in round-trip against the
 * dev server, driven by a Chrome virtual authenticator (no real biometric).
 *
 *  - Registration calls navigator.credentials.create({ extensions: { prf: {} } }).
 *  - Sign-in calls navigator.credentials.get(...) against the same passkey.
 *
 * Both ceremonies are the genuine browser WebAuthn APIs — only the
 * authenticator is virtual. No backend is needed (registration + unlock are
 * local: passkey + storage only).
 */

/** Fill the username and submit. Retries the fill until the SSR form has
 *  hydrated (the submit button is disabled until React sees the value), so
 *  the test doesn't race the dev server's hydration tick. */
async function registerPasskey(page: Page, username: string) {
  await page.goto('/register')
  const input = page.getByLabel('Username')
  const submit = page.getByRole('button', { name: /create account/i })
  await expect(async () => {
    await input.fill(username)
    await expect(submit).toBeEnabled({ timeout: 1000 })
  }).toPass()
  await submit.click()
}

test('register a wallet passkey, then sign in with it', async ({ page }) => {
  await addVirtualAuthenticator(page)

  // --- Register: create() mints a resident passkey with the PRF extension.
  await registerPasskey(page, 'e2euser')

  // On success the app routes to the sign-in step.
  await expect(page).toHaveURL(/\/login/)

  // --- Sign in: get() asserts the passkey and opens a wallet session.
  await page.getByRole('button', { name: /sign in with passkey/i }).click()

  // registered-but-no-card lands on /add-provider; a full wallet lands on
  // /wallet. Either means the WebAuthn assertion succeeded.
  await expect(page).toHaveURL(/\/add-provider|\/wallet/)
})

test('the registered passkey persists in the wallet (#passkey)', async ({ page }) => {
  await addVirtualAuthenticator(page)

  await registerPasskey(page, 'persistuser')
  await expect(page).toHaveURL(/\/login/)

  // The wallet recorded the WebAuthn credential locally (the unlock gate).
  const passkey = await page.evaluate(() => localStorage.getItem('owl_webauthn_credential'))
  expect(passkey).not.toBeNull()
  expect(JSON.parse(passkey as string).credentialId).toBeTruthy()
})
