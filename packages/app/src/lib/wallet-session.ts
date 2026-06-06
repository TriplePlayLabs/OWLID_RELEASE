// The wallet "session" is a UX gate only: it decides whether the locked
// overlay is shown. It is NOT the security boundary — every holder-key use
// (present, prove) is independently gated by a passkey PRF assertion, so
// clearing this flag never exposes plaintext on its own.
const UNLOCKED_UNTIL_KEY = 'owl_wallet_unlocked_until'
const SESSION_EVENT = 'owlid:wallet-session-change'

export const WALLET_SESSION_TTL_MS = 15 * 60 * 1000

// Auto-lock must stand down while the user is mid-flow in a way that legitimately
// backgrounds the tab. Two such cases, both ref-counted:
//   - a passkey ceremony (navigator.credentials.*) hides the page on mobile;
//   - a provider verification is in flight (popup/redirect has focus).
// The hidden-lock and TTL-expiry checks skip while either is active.
let passkeyCeremonyDepth = 0
let verificationDepth = 0

export function isPasskeyCeremonyActive(): boolean {
  return passkeyCeremonyDepth > 0
}

export function isVerificationSessionActive(): boolean {
  return verificationDepth > 0
}

export function isAutoLockSuspended(): boolean {
  return isPasskeyCeremonyActive() || isVerificationSessionActive()
}

export async function withPasskeyCeremony<T>(fn: () => Promise<T>): Promise<T> {
  passkeyCeremonyDepth += 1
  try {
    return await fn()
  } finally {
    passkeyCeremonyDepth = Math.max(0, passkeyCeremonyDepth - 1)
  }
}

/** Suspend auto-lock for an in-flight provider verification. Returns the
 *  matching release; calling it twice is a no-op. */
export function beginVerificationSession(): () => void {
  verificationDepth += 1
  let released = false
  return () => {
    if (released) return
    released = true
    verificationDepth = Math.max(0, verificationDepth - 1)
  }
}

function canUseSessionStorage(): boolean {
  return typeof window !== 'undefined' && typeof sessionStorage !== 'undefined'
}

function emitSessionChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(SESSION_EVENT))
  }
}

export function walletSessionMsRemaining(): number {
  if (!canUseSessionStorage()) return 0
  const raw = sessionStorage.getItem(UNLOCKED_UNTIL_KEY)
  const until = raw ? Number(raw) : 0
  return Number.isFinite(until) ? Math.max(0, until - Date.now()) : 0
}

export function hasWalletSession(): boolean {
  if (!canUseSessionStorage()) return false
  if (walletSessionMsRemaining() > 0) return true
  sessionStorage.removeItem(UNLOCKED_UNTIL_KEY)
  return false
}

export function startWalletSession(durationMs = WALLET_SESSION_TTL_MS): void {
  if (!canUseSessionStorage()) return
  sessionStorage.setItem(UNLOCKED_UNTIL_KEY, String(Date.now() + durationMs))
  emitSessionChange()
}

export function refreshWalletSession(durationMs = WALLET_SESSION_TTL_MS): void {
  if (hasWalletSession()) startWalletSession(durationMs)
}

export function endWalletSession(): void {
  if (!canUseSessionStorage()) return
  sessionStorage.removeItem(UNLOCKED_UNTIL_KEY)
  emitSessionChange()
}

export function subscribeWalletSession(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(SESSION_EVENT, listener)
  window.addEventListener('storage', listener)
  window.addEventListener('focus', listener)
  document.addEventListener('visibilitychange', listener)
  return () => {
    window.removeEventListener(SESSION_EVENT, listener)
    window.removeEventListener('storage', listener)
    window.removeEventListener('focus', listener)
    document.removeEventListener('visibilitychange', listener)
  }
}
