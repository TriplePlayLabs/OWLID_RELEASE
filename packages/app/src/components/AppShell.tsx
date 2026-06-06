import { Outlet, useRouterState } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { Fingerprint, Loader2, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@owlid/ui/components/ui/button'
import { useIdentity } from '~/hooks/use-identity'
import { ResetIdentityDialog } from '~/components/identity/ResetIdentityDialog'
import { useWalletSession } from '~/hooks/use-wallet-session'
import { AppHeader } from '~/components/identity/AppHeader'
import { applySettingsToSdk, loadSettings } from '~/lib/settings'

/**
 * Root-level layout route component. Renders the shared app chrome
 * (sticky `AppHeader` + dark min-h-screen background) and an `<Outlet />`
 * for the matched child route. Wired into `__root.tsx` via `component`
 * — every page inherits it without per-route boilerplate.
 */
export function AppShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { isIdentityCreated, isRegistered, resetDemo } = useIdentity()
  const sessionEnabled = isRegistered || isIdentityCreated
  const { isLocked, isUnlocking, lock, unlock } = useWalletSession(sessionEnabled)
  // Menu surfaces Settings / Reset which are useful as soon as the user
  // has a passkey, even if no credentials have been added yet (e.g. they
  // bounced off a failed first issuance). Gating on `isIdentityCreated`
  // alone hid the menu on /add-provider for first-time users.
  const showMenu = isIdentityCreated || isRegistered

  // Bootstrap user settings into the SDK once on mount. `loadSettings()`
  // is a no-op on SSR, so this runs exactly once after hydration before
  // any `OwlWallet.present` call.
  const settingsBootstrapped = useRef(false)
  useEffect(() => {
    if (settingsBootstrapped.current) return
    settingsBootstrapped.current = true
    applySettingsToSdk(loadSettings())
  }, [])

  const [resetOpen, setResetOpen] = useState(false)
  const handleReset = () => setResetOpen(true)

  const handleUnlock = async () => {
    try {
      await unlock()
      toast.success('Wallet unlocked')
    } catch (error) {
      toast.error('Unlock failed', {
        description: error instanceof Error ? error.message : 'Passkey was not accepted.',
      })
    }
  }

  const lockBypasses =
    pathname === '/' || pathname === '/login' || pathname === '/register' || pathname === '/faq'
  const shouldShowLockOverlay = sessionEnabled && isLocked && !lockBypasses

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans selection:bg-white/20 overflow-x-hidden">
      <AppHeader
        showMenu={showMenu}
        isLocked={isLocked}
        onReset={handleReset}
        onLock={lock}
        onUnlock={handleUnlock}
      />
      <main className="flex-1 w-full flex flex-col">
        {shouldShowLockOverlay ? (
          <WalletLockedScreen onUnlock={handleUnlock} isUnlocking={isUnlocking} />
        ) : (
          <Outlet />
        )}
      </main>
      <ResetIdentityDialog open={resetOpen} onOpenChange={setResetOpen} onWipe={resetDemo} />
    </div>
  )
}

function WalletLockedScreen({
  onUnlock,
  isUnlocking,
}: {
  onUnlock: () => void
  isUnlocking: boolean
}) {
  return (
    <div className="w-full max-w-md mx-auto px-4 pt-16 pb-12 flex flex-col items-center text-center">
      <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white">
        <Lock className="h-6 w-6" />
      </div>
      <h1 className="text-xl font-semibold tracking-tight">Wallet locked</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        Unlock with your passkey to view cards, add credentials, or present proofs.
      </p>
      <Button
        onClick={onUnlock}
        disabled={isUnlocking}
        className="mt-6 w-full bg-white text-black hover:bg-white/90 h-12 text-base font-medium"
        data-testid="button-unlock-wallet-overlay"
      >
        {isUnlocking ? (
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        ) : (
          <Fingerprint className="w-4 h-4 mr-2" />
        )}
        Unlock wallet
      </Button>
    </div>
  )
}
