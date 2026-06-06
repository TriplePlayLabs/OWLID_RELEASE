import type { Page } from '@playwright/test'

/**
 * Attach a Chrome virtual authenticator (CDP `WebAuthn` domain) to the page
 * so passkey ceremonies run headlessly. `hasPrf` is the key flag: the holder
 * wallet derives its seed-wrapping key from the WebAuthn PRF / hmac-secret
 * extension, and the virtual authenticator returns a deterministic PRF secret
 * — so seal+open round-trips within a session.
 *
 * `isUserVerified` + `automaticPresenceSimulation` make create()/get()
 * resolve without a real user gesture or biometric prompt.
 */
export async function addVirtualAuthenticator(page: Page): Promise<string> {
  const client = await page.context().newCDPSession(page)
  await client.send('WebAuthn.enable')
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  return authenticatorId
}
