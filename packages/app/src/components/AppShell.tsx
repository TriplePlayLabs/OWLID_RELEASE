import { Outlet } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { useIdentity } from '~/hooks/use-identity'
import { AppHeader } from '~/components/identity/AppHeader'
import { applySettingsToSdk, loadSettings } from '~/lib/settings'

/**
 * Root-level layout route component. Renders the shared app chrome
 * (sticky `AppHeader` + dark min-h-screen background) and an `<Outlet />`
 * for the matched child route. Wired into `__root.tsx` via `component`
 * — every page inherits it without per-route boilerplate.
 */
export function AppShell() {
  const { isIdentityCreated, resetDemo } = useIdentity()

  // Bootstrap user settings into the SDK once on mount. `loadSettings()`
  // is a no-op on SSR, so this runs exactly once after hydration before
  // any `OwlWallet.present` call.
  const settingsBootstrapped = useRef(false)
  useEffect(() => {
    if (settingsBootstrapped.current) return
    settingsBootstrapped.current = true
    applySettingsToSdk(loadSettings())
  }, [])

  const handleReset = () => {
    if (confirm('This will clear your local identity and reset. Continue?')) {
      resetDemo()
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans selection:bg-white/20 overflow-x-hidden">
      <AppHeader showMenu={isIdentityCreated} onReset={handleReset} />
      <main className="flex-1 w-full flex flex-col">
        <Outlet />
      </main>
    </div>
  )
}
