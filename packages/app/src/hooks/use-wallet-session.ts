import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useIdentity } from '~/hooks/use-identity'
import { useWebAuthn } from '~/hooks/use-webauthn'
import {
  endWalletSession,
  hasWalletSession,
  isAutoLockSuspended,
  refreshWalletSession,
  startWalletSession,
  subscribeWalletSession,
  walletSessionMsRemaining,
} from '~/lib/wallet-session'

// Grace before a backgrounded tab locks. Long enough to absorb the page-hide
// that the OS passkey sheet triggers on mobile, short enough that genuinely
// switching away locks promptly. Cancelled the moment the tab is visible again.
const HIDDEN_LOCK_GRACE_MS = 3000

export function useWalletSession(enabled = true) {
  const qc = useQueryClient()
  const { credentialId } = useIdentity()
  const { authenticate } = useWebAuthn()
  const hasSession = useSyncExternalStore(subscribeWalletSession, hasWalletSession, () => false)
  const [isUnlocking, setIsUnlocking] = useState(false)

  const lock = useCallback(() => endWalletSession(), [])

  const markUnlocked = useCallback(() => {
    startWalletSession()
  }, [])

  const unlock = useCallback(async () => {
    setIsUnlocking(true)
    try {
      await authenticate(credentialId)
      startWalletSession()
      await qc.invalidateQueries({ queryKey: ['identity'] })
    } finally {
      setIsUnlocking(false)
    }
  }, [authenticate, credentialId, qc])

  useEffect(() => {
    if (!enabled) return

    const refresh = () => refreshWalletSession()
    let hideTimer: number | undefined
    const lockWhenHidden = () => {
      window.clearTimeout(hideTimer)
      if (document.visibilityState !== 'hidden') return
      hideTimer = window.setTimeout(() => {
        // A passkey ceremony or an in-flight provider verification also hides
        // the page; only a sustained hide with neither active is real
        // backgrounding worth locking on.
        if (document.visibilityState === 'hidden' && !isAutoLockSuspended()) {
          endWalletSession()
        }
      }, HIDDEN_LOCK_GRACE_MS)
    }
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart']

    for (const event of events) {
      window.addEventListener(event, refresh, { passive: true })
    }
    document.addEventListener('visibilitychange', lockWhenHidden)

    return () => {
      window.clearTimeout(hideTimer)
      for (const event of events) {
        window.removeEventListener(event, refresh)
      }
      document.removeEventListener('visibilitychange', lockWhenHidden)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled || !hasSession) return
    const ms = walletSessionMsRemaining()
    if (ms <= 0) {
      if (!isAutoLockSuspended()) endWalletSession()
      return
    }
    const timer = window.setTimeout(() => {
      // A verification flow refreshes the session as it polls, so reaching here
      // while suspended means the keep-alive lapsed — re-arm instead of locking.
      if (isAutoLockSuspended()) refreshWalletSession()
      else endWalletSession()
    }, ms + 50)
    return () => window.clearTimeout(timer)
  }, [enabled, hasSession])

  return {
    hasSession: enabled && hasSession,
    isLocked: enabled && !hasSession,
    isUnlocking,
    lock,
    unlock,
    markUnlocked,
  }
}
