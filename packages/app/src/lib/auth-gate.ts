import { storage } from '@owlid/sdk'

// Authoritative storage gates used by every route's `beforeLoad`. Keep
// the truth source in one file so route guards can't drift apart —
// every guard reads the same flags and routes consistently.
//
// State machine:
//   no passkey                 → /register
//   passkey, no credentials    → /add-provider
//   passkey, ≥1 credential     → /wallet
//
// `unknown` is the SSR sentinel: this app uses @tanstack/react-start,
// whose `beforeLoad` runs on the server *and* the client. The server
// has no localStorage, so a naive check would tell every page reload
// "user is unregistered" and force-redirect to /register before the
// client ever hydrated. We return `unknown` from SSR — callers MUST
// treat it as "skip the redirect this turn"; the client re-runs
// `beforeLoad` after hydration and gets a real answer there.

export type AuthState =
  | { kind: 'unknown' }
  | { kind: 'unregistered' }
  | { kind: 'registered-no-card' }
  | { kind: 'has-wallet' }

function isClient(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined'
}

export async function readAuthState(): Promise<AuthState> {
  if (!isClient()) return { kind: 'unknown' }

  const hasPasskey = await storage.hasWebAuthnCredential()
  if (!hasPasskey) {
    // Heal an orphan username: if we have a username string but no
    // passkey, the user is effectively unregistered. Leaving the
    // username around makes the register form look already-completed
    // (input disabled, button hidden).
    if (await storage.loadUsername()) {
      await storage.saveUsername('')
    }
    return { kind: 'unregistered' }
  }
  const hasAnyCard = await storage.hasAnyCredential()
  return hasAnyCard ? { kind: 'has-wallet' } : { kind: 'registered-no-card' }
}

export const ROUTE_FOR_STATE: Record<
  Exclude<AuthState['kind'], 'unknown'>,
  '/register' | '/add-provider' | '/wallet'
> = {
  unregistered: '/register',
  'registered-no-card': '/add-provider',
  'has-wallet': '/wallet',
}
