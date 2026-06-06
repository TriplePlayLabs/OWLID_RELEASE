import { test, expect } from '@playwright/test'

/**
 * GH #16 — "Reset & clear identity". Real flow against the dev server: a
 * registered holder opens the menu and taps "Reset & Clear Identity". The
 * dialog defaults to a device-local wipe and offers an OPT-IN on-chain
 * revocation (holder proof-of-possession). Here we assert the default
 * wipe-only path; the revoke specifics are covered by RTL + SDK unit + the
 * Rust PoP e2e.
 *
 * Identity is seeded into localStorage so the menu is reachable without a
 * real authenticator; a sentinel surviving storage.clearAll() stops the
 * post-wipe reload from re-seeding.
 */

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

test('reset offers opt-in revocation and wipes the device by default (#16)', async ({ page }) => {
  await page.addInitScript(seedRegisteredHolder)
  await page.route('**/providers', (route) => route.fulfill({ json: [] }))

  await page.goto('/add-provider')

  // aria-label="Menu" uniquely identifies the dropdown trigger.
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('menuitem', { name: /reset & clear identity/i }).click()

  // The dialog is honest about the default (device wipe) and offers opt-in
  // network revocation — directly answering the issue's question.
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/this device only/i)).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: /revoke my id on the network/i })).toBeVisible()

  // Default path: leave the box unchecked and wipe locally.
  await dialog.getByRole('button', { name: /wipe this device/i }).click()

  // Storage wiped + reload -> registered state gone (menu disappears).
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toHaveCount(0)
  const passkey = await page.evaluate(() => localStorage.getItem('owl_webauthn_credential'))
  expect(passkey).toBeNull()
})

// QA #1 (Critical) — the deployed build wiped the wallet on a single menu
// click with no confirmation. This pins the guard: choosing the menu item
// must NOT destroy anything until the holder confirms, and Cancel must be a
// safe no-op that leaves the identity fully intact.
test('reset requires confirmation — menu click + Cancel never wipes (#1)', async ({ page }) => {
  await page.addInitScript(seedRegisteredHolder)
  await page.route('**/providers', (route) => route.fulfill({ json: [] }))

  await page.goto('/add-provider')

  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('menuitem', { name: /reset & clear identity/i }).click()

  // A confirmation dialog must appear — nothing destroyed yet.
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const stillThere = await page.evaluate(() => localStorage.getItem('owl_webauthn_credential'))
  expect(stillThere).not.toBeNull()

  // Cancel is a no-op: dialog closes, identity untouched, menu still present.
  await dialog.getByRole('button', { name: /cancel/i }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible()
  const afterCancel = await page.evaluate(() => localStorage.getItem('owl_webauthn_credential'))
  expect(afterCancel).not.toBeNull()
})
