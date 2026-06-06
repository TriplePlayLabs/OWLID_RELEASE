/**
 * Regression for QA #2 — "Save credential fails to persist and loops back
 * to verifying". These tests drive the full confirm → issue state machine
 * in `useVerifyAndIssueWithWebAuthn` to prove:
 *   1. a successful issue persists the credential and flips to success
 *      (storage write happens exactly once, credentialData is populated);
 *   2. a failed issue surfaces the error and returns to awaiting-confirmation
 *      (the "Save credential" button) — it does NOT get stuck on the
 *      "Verifying…" spinner, and writes nothing.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createElement } from 'react'

let completion: { status: string; message?: string; claims?: unknown } = { status: 'pending' }
const completeVerification = mock(() => Promise.resolve(completion))
const autoVerify = mock(() => Promise.resolve({}))

let issueResult: {
  success: boolean
  credential?: string
  error?: string
  personhoodSecretHex?: string
} = {
  success: true,
  credential: 'sdjwt~payload~kb',
}
const issueCredential = mock(() => Promise.resolve(issueResult))

mock.module('@owlid/sdk/issuer', () => ({
  getSessionsApi: () => ({ completeVerification, autoVerify }),
  getCredentialsApi: () => ({ issueCredential }),
}))

const createSession = mock(() =>
  Promise.resolve({
    sessionId: 's1',
    sessionToken: 'tok',
    providerId: 'didit',
    flowType: 'webhook_async',
    url: 'https://didit.example/verify',
  }),
)

mock.module('~/lib/api', () => ({
  sessionsApi: { createSession },
  providersApi: {},
  infoApi: {},
}))

mock.module('~/lib/passkeys', () => ({
  currentPasskeyId: () => Promise.resolve('passkey-1'),
  wrapWalletHolderKey: () => Promise.resolve('wrapped-seed'),
}))

mock.module('~/lib/wallet-session', () => ({
  beginVerificationSession: () => () => {},
  refreshWalletSession: () => {},
}))

const restoreCredentialsFromVerifiedSession = mock(() => Promise.resolve([]))
const backupIssuedCredential = mock(() => Promise.resolve())
mock.module('~/lib/credential-recovery', () => ({
  restoreCredentialsFromVerifiedSession,
  backupIssuedCredential,
}))

const addCredential = mock(() => Promise.resolve())
mock.module('@owlid/sdk', () => ({
  KeyPair: { generate: () => ({ publicKeyHex: () => 'pub-hex', toHex: () => 'seed-hex' }) },
  SdJwtVc: { parse: () => ({ credentialId: () => 'cred-id', peekIssuer: () => 'did:web:issuer' }) },
  buildCardShape: () => ({ kind: 'generic' }),
  prewarmCredentialAttestations: () => Promise.resolve(),
  storage: { addCredential },
}))

const { useVerifyAndIssueWithWebAuthn } = await import('../src/hooks/use-idp-api')

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

function fakePopup() {
  return { closed: false, close() {}, location: { href: '' } } as unknown as Window
}

const verifiedClaims = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  dateOfBirth: '1990-01-01',
  verifiedAt: '2026-01-01T00:00:00.000Z',
  providerId: 'didit',
  verificationMethod: 'document',
  verificationLevel: 'high',
}

async function reachAwaitingConfirmation() {
  completion = { status: 'verified', claims: verifiedClaims }
  const view = renderHook(() => useVerifyAndIssueWithWebAuthn(), { wrapper })
  await act(async () => {
    await view.result.current.mutateAsync({
      providerId: 'didit',
      providerName: 'Didit',
      username: 'u',
      popup: fakePopup(),
    })
  })
  await waitFor(() => expect(view.result.current.awaitingConfirmation).toBe(true))
  return view
}

beforeEach(() => {
  completion = { status: 'pending' }
  issueResult = { success: true, credential: 'sdjwt~payload~kb' }
  completeVerification.mockClear()
  issueCredential.mockClear()
  addCredential.mockClear()
  restoreCredentialsFromVerifiedSession.mockClear()
  backupIssuedCredential.mockClear()
})

describe('save credential — confirm & issue (#2)', () => {
  test('successful issue persists the credential exactly once and flips to success', async () => {
    const { result } = await reachAwaitingConfirmation()

    act(() => result.current.confirmAndIssue())

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.credentialData).toBeDefined()
    expect(result.current.credentialData?.credentialId).toBe('cred-id')
    expect(addCredential).toHaveBeenCalledTimes(1)
    expect(result.current.isError).toBe(false)
    // Not stuck pretending to still verify.
    expect(result.current.awaitingConfirmation).toBe(false)
  })

  test('failed issue surfaces the error and returns to the Save button (not stuck verifying)', async () => {
    issueResult = { success: false, error: 'issuer refused to mint' }
    const { result } = await reachAwaitingConfirmation()

    act(() => result.current.confirmAndIssue())

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toContain('issuer refused to mint')
    expect(result.current.credentialData).toBeUndefined()
    expect(result.current.isSuccess).toBe(false)
    expect(addCredential).not.toHaveBeenCalled()
    // The key anti-regression: control returns to the confirmation button
    // instead of spinning forever on "Verifying…".
    expect(result.current.awaitingConfirmation).toBe(true)
    expect(result.current.isPending).toBe(false)
  })
})
