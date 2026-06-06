/**
 * Regression for GH #8 — "with the Didit (DID/IIT) connection it always
 * creates an identity even if verification fails, and the identity screen
 * says 'created credential' before verification has actually succeeded".
 *
 * These tests pin the gating in `useVerifyAndIssueWithWebAuthn`:
 *   1. provider says `failed`  -> NO credential, error surfaced.
 *   2. provider says `verified`-> awaiting-confirmation, STILL no credential
 *      until the user taps "Save credential" (issuance is user-gated).
 *
 * Every dependency that would pull in WebAuthn / the wallet / the issuer
 * service is mocked, so the hook runs headless under jsdom.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createElement } from 'react'

// --- Controllable provider-completion result -------------------------------
let completion: { status: string; message?: string; claims?: unknown } = { status: 'pending' }
const completeVerification = mock(() => Promise.resolve(completion))
const autoVerify = mock(() => Promise.resolve({}))

mock.module('@owlid/sdk/issuer', () => ({
  getSessionsApi: () => ({ completeVerification, autoVerify }),
  getCredentialsApi: () => ({}),
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
  wrapWalletHolderKey: () => Promise.resolve('wrapped'),
}))

mock.module('~/lib/wallet-session', () => ({
  beginVerificationSession: () => () => {},
  refreshWalletSession: () => {},
}))

// If these ran, a credential would be created — the failure-path test
// asserts they do NOT, so a call here would be a real regression.
const restoreCredentialsFromVerifiedSession = mock(() => Promise.resolve([]))
const issueAndStoreSpy = mock(() => {})
mock.module('~/lib/credential-recovery', () => ({
  restoreCredentialsFromVerifiedSession,
  backupIssuedCredential: () => Promise.resolve(),
}))

mock.module('@owlid/sdk', () => ({
  KeyPair: class {},
  SdJwtVc: class {},
  buildCardShape: () => ({}),
  prewarmCredentialAttestations: () => {
    issueAndStoreSpy()
  },
  storage: { addCredential: async () => {} },
}))

const { useVerifyAndIssueWithWebAuthn, redirectStatusMessage } =
  await import('../src/hooks/use-idp-api')

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

function fakePopup() {
  return { closed: false, close() {}, location: { href: '' } } as unknown as Window
}

beforeEach(() => {
  completion = { status: 'pending' }
  completeVerification.mockClear()
  restoreCredentialsFromVerifiedSession.mockClear()
  issueAndStoreSpy.mockClear()
})

describe('useVerifyAndIssueWithWebAuthn — Didit gating (#8)', () => {
  test('provider failure issues NO credential and surfaces the error', async () => {
    completion = { status: 'failed', message: 'KYC declined' }
    const { result } = renderHook(() => useVerifyAndIssueWithWebAuthn(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        providerId: 'didit',
        providerName: 'Didit',
        username: 'u',
        popup: fakePopup(),
      })
    })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toContain('KYC declined')
    // The two complaints from #8: no identity created, not "success".
    expect(result.current.credentialData).toBeUndefined()
    expect(result.current.isSuccess).toBe(false)
    expect(result.current.awaitingConfirmation).toBe(false)
    expect(restoreCredentialsFromVerifiedSession).not.toHaveBeenCalled()
  })

  test('provider verified does NOT auto-create — waits for user confirmation', async () => {
    completion = {
      status: 'verified',
      claims: { firstName: 'A', verifiedAt: new Date().toISOString() },
    }
    const { result } = renderHook(() => useVerifyAndIssueWithWebAuthn(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        providerId: 'didit',
        providerName: 'Didit',
        username: 'u',
        popup: fakePopup(),
      })
    })

    await waitFor(() => expect(result.current.awaitingConfirmation).toBe(true))
    // Credential must NOT exist before the user taps "Save credential".
    expect(result.current.credentialData).toBeUndefined()
    expect(result.current.isSuccess).toBe(false)
    expect(restoreCredentialsFromVerifiedSession).not.toHaveBeenCalled()
  })
})

// Regression for QA #4 — the in-app "complete verification" line was
// hardcoded to "Didit" for every redirect provider (it is wrong for the
// Google / OIDC flow, which is a popup sign-in with no mobile handoff).
describe('redirectStatusMessage — names the actual provider (#4)', () => {
  const make = (flowType: string, providerName: string) =>
    ({ session: { flowType }, providerName }) as unknown as Parameters<
      typeof redirectStatusMessage
    >[0]

  test('no active redirect → no message', () => {
    expect(redirectStatusMessage(null)).toBeUndefined()
  })

  test('Didit (webhook_async) keeps the mobile-handoff copy, named', () => {
    const msg = redirectStatusMessage(make('webhook_async', 'Didit'))
    expect(msg).toContain('Didit')
    expect(msg).toContain('mobile handoff')
  })

  test('Google (oidc_redirect) names Google, drops "Didit" and mobile-handoff', () => {
    const msg = redirectStatusMessage(make('oidc_redirect', 'Google'))
    expect(msg).toContain('Google')
    expect(msg).not.toContain('Didit')
    expect(msg).not.toContain('mobile handoff')
  })

  test('blank provider name falls back to a generic noun', () => {
    expect(redirectStatusMessage(make('oidc_redirect', '  '))).toContain('the provider')
  })
})

describe('useVerifyAndIssueWithWebAuthn — statusMessage reflects the chosen provider (#4)', () => {
  test('Google redirect flow surfaces "Google", never "Didit"', async () => {
    completion = { status: 'pending' }
    createSession.mockImplementationOnce(() =>
      Promise.resolve({
        sessionId: 's2',
        sessionToken: 'tok',
        providerId: 'google',
        flowType: 'oidc_redirect',
        url: 'https://accounts.google.com/o/oauth2/v2/auth',
      }),
    )
    const { result } = renderHook(() => useVerifyAndIssueWithWebAuthn(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        providerId: 'google',
        providerName: 'Google',
        username: 'u',
        popup: fakePopup(),
      })
    })

    await waitFor(() => expect(result.current.statusMessage).toBeTruthy())
    expect(result.current.statusMessage).toContain('Google')
    expect(result.current.statusMessage).not.toContain('Didit')
  })
})
