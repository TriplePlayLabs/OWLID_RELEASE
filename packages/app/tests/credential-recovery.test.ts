import { beforeEach, describe, expect, mock, test } from 'bun:test'

let recoveryEnabled = true
const stored: Array<{ cred: { credentialId: string }; wrapped: string }> = []
let decryptCalls = 0
let wrapCalls = 0

mock.module('~/lib/settings', () => ({
  loadSettings: () => ({ encryptedRecoveryEnabled: recoveryEnabled }),
}))

mock.module('@owlid/sdk', () => ({
  storage: {
    addCredential: async (cred: { credentialId: string }, wrapped: string) => {
      stored.push({ cred, wrapped })
    },
  },
}))

mock.module('~/lib/passkeys', () => ({
  // One prompt → decrypt every blob. Test passes bundle JSON as ciphertext.
  decryptRecoveryPayloads: async (ciphertexts: string[]) => {
    decryptCalls += 1
    return ciphertexts
  },
  // One prompt → wrap every seed.
  wrapWalletHolderKeys: async (seedHexes: string[]) => {
    wrapCalls += 1
    return seedHexes.map((s) => `wrapped:${s}`)
  },
  encryptRecoveryPayload: async (p: string) => p,
}))

const { restoreCredentialsFromVerifiedSession } = await import('../src/lib/credential-recovery')

function bundle(credentialId: string, seed: string): string {
  return JSON.stringify({
    version: 'owlid-recovery-bundle-v1',
    credential: { credentialId, providerId: 'didit', issuer: 'iss' },
    holderSeedHex: seed,
  })
}

function fakeApi(ciphertexts: string[]) {
  return {
    listRecoveryBackups: async () => ({
      backups: ciphertexts.map((ciphertext, i) => ({ ciphertext, credentialId: `c${i}` })),
    }),
  } as never
}

describe('restoreCredentialsFromVerifiedSession', () => {
  beforeEach(() => {
    recoveryEnabled = true
    stored.length = 0
    decryptCalls = 0
    wrapCalls = 0
  })

  test('restores every backup with a single decrypt and single wrap prompt', async () => {
    const api = fakeApi([bundle('c0', 'aa'), bundle('c1', 'bb'), bundle('c2', 'cc')])

    const restored = await restoreCredentialsFromVerifiedSession({ api, sessionId: 's' })

    expect(restored.map((c) => c.credentialId)).toEqual(['c0', 'c1', 'c2'])
    expect(stored.map((s) => s.cred.credentialId)).toEqual(['c0', 'c1', 'c2'])
    expect(stored.map((s) => s.wrapped)).toEqual(['wrapped:aa', 'wrapped:bb', 'wrapped:cc'])
    expect(decryptCalls).toBe(1)
    expect(wrapCalls).toBe(1)
  })

  test('skips malformed bundles but restores the valid ones', async () => {
    const api = fakeApi([bundle('c0', 'aa'), 'not-json', bundle('c2', 'cc')])

    const restored = await restoreCredentialsFromVerifiedSession({ api, sessionId: 's' })

    expect(restored.map((c) => c.credentialId)).toEqual(['c0', 'c2'])
    expect(wrapCalls).toBe(1)
  })

  test('returns nothing when recovery is disabled', async () => {
    recoveryEnabled = false
    const api = fakeApi([bundle('c0', 'aa')])

    const restored = await restoreCredentialsFromVerifiedSession({ api, sessionId: 's' })

    expect(restored).toEqual([])
    expect(decryptCalls).toBe(0)
  })

  test('returns nothing when there are no backups', async () => {
    const restored = await restoreCredentialsFromVerifiedSession({
      api: fakeApi([]),
      sessionId: 's',
    })

    expect(restored).toEqual([])
    expect(decryptCalls).toBe(0)
  })
})
