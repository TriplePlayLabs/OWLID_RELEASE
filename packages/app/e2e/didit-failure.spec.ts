import { test, expect } from '@playwright/test'

/**
 * GH #8 — "with the Didit (DID/IIT) connection it always creates an identity
 * even if verification fails".
 *
 * Real flow against the dev server: a registered holder opens /add-provider,
 * picks the Didit (webhook_async) provider, and the provider comes back
 * `failed`. We assert the app surfaces the failure and does NOT create a
 * credential or bounce to the wallet. All issuer traffic is network-mocked;
 * the failure path stops before any WebAuthn ceremony, so no authenticator
 * is needed.
 */

const PROVIDER = {
  id: 'didit',
  name: 'Didit ID Check',
  country: 'US',
  description: 'Government ID verification',
  enabled: true,
  flowType: 'webhook_async',
  verificationLevel: 'high',
  verificationLevels: ['high'],
}

function seedRegisteredHolder() {
  if (localStorage.getItem('__e2e_seeded')) return
  localStorage.setItem('__e2e_seeded', '1')
  localStorage.setItem(
    'owl_webauthn_credential',
    JSON.stringify({
      credentialId: 'pk-e2e',
      publicKey: 'pub',
      counter: 0,
      transports: ['internal'],
    }),
  )
  sessionStorage.setItem('owl_wallet_unlocked_until', String(Date.now() + 15 * 60 * 1000))
}

test('a failed Didit verification creates NO credential and stays on the page (#8)', async ({
  page,
}) => {
  await page.addInitScript(seedRegisteredHolder)
  await page.route('**/providers', (route) => route.fulfill({ json: [PROVIDER] }))
  await page.route('**/sessions', (route) =>
    route.fulfill({
      json: {
        providerId: 'didit',
        sessionId: 's1',
        sessionToken: 'tok',
        flowType: 'webhook_async',
        type: 'redirect',
        url: 'about:blank',
      },
    }),
  )
  // The provider declines — this is the path that used to wrongly mint an ID.
  await page.route('**/sessions/*/complete', (route) =>
    route.fulfill({ json: { status: 'failed', message: 'KYC declined' } }),
  )

  await page.goto('/add-provider')

  await page.getByRole('button', { name: /didit id check/i }).click()

  // The failure is surfaced...
  await expect(page.getByText(/kyc declined/i)).toBeVisible()
  // ...and crucially NO success / navigation happened.
  await expect(page).toHaveURL(/\/add-provider/)
  await expect(page.getByText(/card added/i)).toHaveCount(0)
  await expect(page.getByText(/opening wallet/i)).toHaveCount(0)
})
