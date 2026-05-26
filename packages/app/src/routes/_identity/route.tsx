import { createFileRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'
import { readAuthState } from '~/lib/auth-gate'

export const Route = createFileRoute('/_identity')({
  component: IdentityLayout,
})

/**
 * Pathless layout route for the `_identity` group. The shared app
 * chrome (header + background) lives in `__root` via `AppShell`; this
 * layer adds only a post-hydration auth guard + an `<Outlet />` for
 * the matched child page.
 *
 * Why the extra guard: route-level `beforeLoad` runs once on the SSR
 * pass and TanStack Start trusts the result. If localStorage state
 * changed between SSR and client mount (typically after a reset) the
 * guard can't see it. This effect re-checks on every navigation
 * client-side and force-navigates to the right gate.
 */
function IdentityLayout() {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  useEffect(() => {
    if (typeof window === 'undefined') return
    let cancelled = false
    void (async () => {
      const state = await readAuthState()
      if (cancelled || state.kind === 'unknown') return
      const PROTECTED_NEEDS_PASSKEY = ['/wallet', '/add-provider', '/recent-proofs', '/callback']
      const PROTECTED_NEEDS_WALLET = ['/wallet']
      const needsPasskey = PROTECTED_NEEDS_PASSKEY.some((p) => pathname.startsWith(p))
      const needsWallet = PROTECTED_NEEDS_WALLET.some((p) => pathname.startsWith(p))
      if (needsPasskey && state.kind === 'unregistered') {
        navigate({ to: '/register', replace: true })
      } else if (needsWallet && state.kind === 'registered-no-card') {
        navigate({ to: '/add-provider', replace: true })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pathname, navigate])

  return <Outlet />
}
