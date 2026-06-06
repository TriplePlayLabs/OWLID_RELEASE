import { beforeEach, describe, expect, test } from 'bun:test'
import { STORAGE_KEYS, storage, type WalletCredential } from '@owlid/sdk'
import { readAuthState } from '../src/lib/auth-gate'

function credential(overrides: Partial<WalletCredential> = {}): WalletCredential {
  return {
    credentialId: overrides.credentialId ?? 'wallet-card',
    sdJwtVc: overrides.sdJwtVc ?? 'eyJ.eyJ.sig~D~',
    issuer: overrides.issuer ?? 'did:web:issuer.example',
    providerId: overrides.providerId ?? 'didit',
    issuedAt: overrides.issuedAt ?? '2026-06-03T00:00:00.000Z',
    cardShape: overrides.cardShape ?? { kind: 'passport' },
    verifiedClaims: overrides.verifiedClaims ?? { firstName: 'Jane' },
    holderPublicKeyHex: overrides.holderPublicKeyHex ?? 'aabbcc',
    ...overrides,
  }
}

describe('readAuthState', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  test('routes wallet data without passkey metadata to passkey repair', async () => {
    await storage.addCredential(credential(), 'wrapped-key')

    expect(await readAuthState()).toEqual({ kind: 'needs-passkey-repair' })
  })

  test('routes registered wallet to wallet', async () => {
    await storage.saveWebAuthnCredential({
      credentialId: 'passkey',
      publicKey: 'public-key',
      counter: 0,
      transports: ['internal'],
    })
    await storage.addCredential(credential(), 'wrapped-key')

    expect(await readAuthState()).toEqual({ kind: 'has-wallet' })
  })

  test('clears orphan username when there is no wallet and no passkey', async () => {
    localStorage.setItem(STORAGE_KEYS.USERNAME, 'orphan')

    expect(await readAuthState()).toEqual({ kind: 'unregistered' })
    expect(localStorage.getItem(STORAGE_KEYS.USERNAME)).toBe('')
  })
})
