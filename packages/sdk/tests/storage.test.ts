import { describe, expect, test } from 'bun:test'
import {
  buildCardShape,
  CredentialStorageManager,
  STORAGE_KEYS,
  type StorageAdapter,
  type VerifiedClaims,
  type WalletCredential,
} from '../src/storage.js'

function inMemoryAdapter(): StorageAdapter & { dump: () => Record<string, string> } {
  const store = new Map<string, string>()
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, v)
    },
    removeItem: (k) => {
      store.delete(k)
    },
    dump: () => Object.fromEntries(store),
  }
}

function makeCredential(over: Partial<WalletCredential> = {}): WalletCredential {
  return {
    credentialId: over.credentialId ?? 'cred-aaa',
    sdJwtVc: over.sdJwtVc ?? 'eyJ.eyJ.sig~D~',
    issuer: over.issuer ?? 'did:web:issuer.example',
    providerId: over.providerId ?? 'didit',
    issuedAt: over.issuedAt ?? '2026-05-20T10:00:00.000Z',
    cardShape: over.cardShape ?? { kind: 'passport' },
    verifiedClaims: over.verifiedClaims ?? { firstName: 'Jane', isOver18: true },
    holderPublicKeyHex: over.holderPublicKeyHex ?? 'aabbcc',
    ...over,
  }
}

describe('CredentialStorageManager', () => {
  test('empty wallet reports no credentials', async () => {
    const m = new CredentialStorageManager(inMemoryAdapter())
    expect(await m.listCredentials()).toEqual([])
    expect(await m.hasAnyCredential()).toBe(false)
    expect(await m.getCredential('missing')).toBeNull()
    expect(await m.getCredentialKeyWrapped('missing')).toBeNull()
  })

  test('addCredential round-trips via list + get', async () => {
    const adapter = inMemoryAdapter()
    const m = new CredentialStorageManager(adapter)
    const cred = makeCredential({ credentialId: 'cred-1' })
    await m.addCredential(cred, 'wrap-1')

    expect(await m.listCredentials()).toEqual([cred])
    expect(await m.getCredential('cred-1')).toEqual(cred)
    expect(await m.getCredentialKeyWrapped('cred-1')).toBe('wrap-1')
    expect(await m.hasAnyCredential()).toBe(true)

    const dump = adapter.dump()
    expect(JSON.parse(dump[STORAGE_KEYS.WALLET_INDEX])).toEqual(['cred-1'])
    expect(dump[`${STORAGE_KEYS.WALLET_CRED_PREFIX}cred-1`]).toContain('cred-1')
    expect(dump[`${STORAGE_KEYS.WALLET_KEY_PREFIX}cred-1`]).toBe('wrap-1')
  })

  test('two credentials preserve insertion order', async () => {
    const m = new CredentialStorageManager(inMemoryAdapter())
    const a = makeCredential({ credentialId: 'a', providerId: 'didit' })
    const b = makeCredential({ credentialId: 'b', providerId: 'google' })
    await m.addCredential(a, 'wa')
    await m.addCredential(b, 'wb')

    const list = await m.listCredentials()
    expect(list.map((c) => c.credentialId)).toEqual(['a', 'b'])
    expect(list.map((c) => c.providerId)).toEqual(['didit', 'google'])
  })

  test('addCredential with duplicate id is idempotent (overwrites payload, keeps index unique)', async () => {
    const m = new CredentialStorageManager(inMemoryAdapter())
    const v1 = makeCredential({ credentialId: 'dup', issuedAt: '2026-01-01T00:00:00.000Z' })
    const v2 = makeCredential({ credentialId: 'dup', issuedAt: '2026-05-20T10:00:00.000Z' })
    await m.addCredential(v1, 'w1')
    await m.addCredential(v2, 'w2')

    const list = await m.listCredentials()
    expect(list).toHaveLength(1)
    expect(list[0]!.issuedAt).toBe('2026-05-20T10:00:00.000Z')
    expect(await m.getCredentialKeyWrapped('dup')).toBe('w2')
  })

  test('removeCredential drops from index + wipes per-cred keys', async () => {
    const adapter = inMemoryAdapter()
    const m = new CredentialStorageManager(adapter)
    await m.addCredential(makeCredential({ credentialId: 'a' }), 'wa')
    await m.addCredential(makeCredential({ credentialId: 'b' }), 'wb')

    await m.removeCredential('a')
    expect((await m.listCredentials()).map((c) => c.credentialId)).toEqual(['b'])
    expect(await m.getCredential('a')).toBeNull()
    expect(await m.getCredentialKeyWrapped('a')).toBeNull()
    expect(adapter.dump()[`${STORAGE_KEYS.WALLET_CRED_PREFIX}a`]).toBeUndefined()
    expect(adapter.dump()[`${STORAGE_KEYS.WALLET_KEY_PREFIX}a`]).toBeUndefined()
  })

  test('hasAnyCredential false when key blob missing', async () => {
    const adapter = inMemoryAdapter()
    const m = new CredentialStorageManager(adapter)
    await m.addCredential(makeCredential({ credentialId: 'orphan' }), 'wk')
    adapter.removeItem(`${STORAGE_KEYS.WALLET_KEY_PREFIX}orphan`)
    expect(await m.hasAnyCredential()).toBe(false)
  })

  test('clearAll wipes wallet + passkey + username', async () => {
    const adapter = inMemoryAdapter()
    const m = new CredentialStorageManager(adapter)
    await m.addCredential(makeCredential(), 'w')
    adapter.setItem(STORAGE_KEYS.WEBAUTHN_CREDENTIAL, '{"x":1}')
    await m.saveUsername('jane')
    await m.clearAll()
    expect(adapter.dump()).toEqual({})
  })

  test('saveSelectedWebAuthnCredential repairs id without inventing public key', async () => {
    const m = new CredentialStorageManager(inMemoryAdapter())
    const repaired = await m.saveSelectedWebAuthnCredential('synced-passkey')

    expect(repaired).toEqual({
      credentialId: 'synced-passkey',
      publicKey: undefined,
      counter: 0,
      transports: ['internal', 'hybrid'],
    })
    expect(await m.loadWebAuthnCredential()).toEqual(repaired)
  })

  test('saveSelectedWebAuthnCredential preserves registration metadata on id repair', async () => {
    const m = new CredentialStorageManager(inMemoryAdapter())
    await m.saveWebAuthnCredential({
      credentialId: 'old-passkey',
      publicKey: 'cose-public-key',
      counter: 7,
      transports: ['hybrid'],
    })

    const repaired = await m.saveSelectedWebAuthnCredential('new-passkey')

    expect(repaired).toEqual({
      credentialId: 'new-passkey',
      publicKey: 'cose-public-key',
      counter: 7,
      transports: ['hybrid'],
    })
  })

  test('saveUsername / loadUsername round-trip', async () => {
    const m = new CredentialStorageManager(inMemoryAdapter())
    expect(await m.loadUsername()).toBeNull()
    await m.saveUsername('jane')
    expect(await m.loadUsername()).toBe('jane')
  })
})

describe('buildCardShape', () => {
  test('didit + mock providers → passport', () => {
    expect(buildCardShape('didit', { portraitImage: 'b64' }).kind).toBe('passport')
    expect(buildCardShape('mock-digid', {}).kind).toBe('passport')
    expect(buildCardShape('mock-bankid', {}).kind).toBe('passport')
  })

  test('google → google-account with hostedDomain', () => {
    const shape = buildCardShape('google', { hostedDomain: 'example.com' } as VerifiedClaims)
    expect(shape).toEqual({ kind: 'google-account', hostedDomain: 'example.com' })
  })

  test('apple → apple-id carries relayEmail', () => {
    const shape = buildCardShape('apple', { isPrivateEmail: true } as VerifiedClaims)
    expect(shape).toEqual({ kind: 'apple-id', relayEmail: true })
  })

  test('unknown provider → generic-oidc brand-named after providerId', () => {
    const shape = buildCardShape('microsoft', {})
    expect(shape).toEqual({ kind: 'generic-oidc', brandName: 'microsoft' })
  })
})
