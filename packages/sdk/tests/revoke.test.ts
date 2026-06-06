/**
 * OwlWallet.revoke — holder self-revocation (proof-of-possession).
 *
 * Verifies the helper fetches a one-shot challenge, signs a KB-JWT over it
 * bound to the self-revoke audience (disclosing nothing), and posts the
 * presentation to /revocations/revoke-mine. `@owlid/verifier-client` and the
 * SD-JWT signer are mocked so the test stays a pure unit.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import * as realVerifierClient from '@owlid/verifier-client'

let capturedReq: { revokeOwnCredentialRequest: Record<string, unknown> } | null = null
const generateChallenge = mock(() => Promise.resolve({ challenge: 'chal-123', expiresIn: 300 }))
const revokeOwnCredential = mock((req: { revokeOwnCredentialRequest: Record<string, unknown> }) => {
  capturedReq = req
  return Promise.resolve({ revoked: true, credentialId: 'cid-server', alreadyRevoked: false })
})
// Spread the real module so the wallet's other deps (midnight/* import
// getMonitoringApi etc.) keep working; override only the two factories
// revoke() calls.
mock.module('@owlid/verifier-client', () => ({
  ...realVerifierClient,
  getVerificationApi: () => ({ generateChallenge }),
  getRevocationsApi: () => ({ revokeOwnCredential }),
}))

let presentArgs: {
  sdJwtVc: string
  holderKeyHex: string
  disclose: string[]
  binding: { aud: string; nonce: string }
} | null = null
mock.module('../src/present.js', () => ({
  presentSdJwtVc: (
    sdJwtVc: string,
    holderKeyHex: string,
    disclose: string[],
    binding: { aud: string; nonce: string },
  ) => {
    presentArgs = { sdJwtVc, holderKeyHex, disclose, binding }
    return 'PRESENTATION'
  },
}))

const { OwlWallet, SELF_REVOKE_AUDIENCE } = await import('../src/wallet.js')

const storage = {
  listCredentials: async () => [{ credentialId: 'cred-A', sdJwtVc: 'SDJWT-A' }],
  getCredentialKeyWrapped: async (id: string) => (id === 'cred-A' ? 'wrapped-A' : null),
} as unknown as ConstructorParameters<typeof OwlWallet>[0]

const openHolderKey = mock(async (_pk: string | null, wrapped: string) => `seed-for-${wrapped}`)
const passkeyResolver = async () => 'pk-1'

function makeWallet() {
  return new OwlWallet(storage, openHolderKey, passkeyResolver, {
    predicateAssets: {} as never,
    predicateTransport: {} as never,
  })
}

beforeEach(() => {
  capturedReq = null
  presentArgs = null
  generateChallenge.mockClear()
  revokeOwnCredential.mockClear()
  openHolderKey.mockClear()
})

describe('OwlWallet.revoke (holder self-revocation)', () => {
  test('builds a PoP presentation bound to the revoke audience + challenge, then posts it', async () => {
    const res = await makeWallet().revoke('cred-A', 'lost device')

    expect(generateChallenge).toHaveBeenCalledTimes(1)
    // Holder key opened from the credential's wrapped seed (passkey unlock).
    expect(openHolderKey).toHaveBeenCalledWith('pk-1', 'wrapped-A')
    // Presentation: disclose nothing; bound to the self-revoke audience + nonce.
    expect(presentArgs?.disclose).toEqual([])
    expect(presentArgs?.binding.aud).toBe(SELF_REVOKE_AUDIENCE)
    expect(presentArgs?.binding.nonce).toBe('chal-123')
    expect(presentArgs?.holderKeyHex).toBe('seed-for-wrapped-A')
    // Posted to revoke-mine with the challenge echoed back.
    expect(capturedReq?.revokeOwnCredentialRequest).toEqual({
      presentation: 'PRESENTATION',
      challenge: 'chal-123',
      reason: 'lost device',
    })
    expect(res).toEqual({ revoked: true, credentialId: 'cid-server', alreadyRevoked: false })
  })

  test('rejects an unknown credential id (never builds a presentation)', async () => {
    await expect(makeWallet().revoke('nope')).rejects.toThrow(/No credential nope/)
    expect(generateChallenge).not.toHaveBeenCalled()
    expect(revokeOwnCredential).not.toHaveBeenCalled()
  })
})
