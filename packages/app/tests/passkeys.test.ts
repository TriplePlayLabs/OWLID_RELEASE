import { beforeEach, describe, expect, test } from 'bun:test'
import { storage } from '@owlid/sdk'
import { currentPasskeyId, rememberSelectedPasskey } from '../src/lib/passkeys'

describe('passkey metadata helpers', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  test('currentPasskeyId is null until metadata exists', async () => {
    expect(await currentPasskeyId()).toBeNull()
  })

  test('rememberSelectedPasskey repairs the locally selected passkey id', async () => {
    await storage.saveWebAuthnCredential({
      credentialId: 'old',
      publicKey: 'public-key',
      counter: 4,
      transports: ['hybrid'],
    })

    await rememberSelectedPasskey('new')

    expect(await currentPasskeyId()).toBe('new')
    expect(await storage.loadWebAuthnCredential()).toEqual({
      credentialId: 'new',
      publicKey: 'public-key',
      counter: 4,
      transports: ['hybrid'],
    })
  })
})
