import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Fingerprint, Loader2, ShieldCheck, Wallet } from 'lucide-react'
import { Button } from '@owlid/ui/components/ui/button'
import { readAuthState } from '~/lib/auth-gate'

export const Route = createFileRoute('/')({
  // Important: this route deliberately does NOT redirect in `beforeLoad`.
  // TanStack Start runs `beforeLoad` once during SSR and trusts the
  // result, so an SSR pass returning "no redirect" (because storage is
  // server-blank) would stick — the user lands on `/` after a reset and
  // never gets bounced to /register. The component below re-checks on
  // the client and either navigates or renders a real landing page.
  component: HomePage,
})

function HomePage() {
  const navigate = useNavigate()
  const [isUnregistered, setIsUnregistered] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const state = await readAuthState()
      if (cancelled) return
      if (state.kind === 'has-wallet') {
        navigate({ to: '/wallet', replace: true })
        return
      }
      if (state.kind === 'registered-no-card') {
        navigate({ to: '/add-provider', replace: true })
        return
      }
      // unregistered (or SSR sentinel that fell through somehow) →
      // show the landing page below with a Get Started CTA.
      setIsUnregistered(true)
    })()
    return () => {
      cancelled = true
    }
  }, [navigate])

  if (isUnregistered === null) {
    return (
      <div className="w-full max-w-md mx-auto px-4 py-20 flex flex-col items-center text-muted-foreground">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    )
  }

  return (
    <div className="w-full max-w-md mx-auto px-4 pt-12 pb-16 flex flex-col items-center text-center">
      <div className="mb-8 flex flex-col items-center gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-white">OwlID</h1>
        <p className="text-sm text-muted-foreground max-w-sm">
          A privacy-preserving digital identity wallet. Verify yourself once, prove what you need —
          nothing more.
        </p>
      </div>

      <div className="w-full space-y-2 mb-10">
        <Feature
          icon={<Fingerprint className="w-4 h-4" />}
          title="Passkey-secured"
          desc="One device passkey unlocks every credential. Keys never leave your device."
        />
        <Feature
          icon={<Wallet className="w-4 h-4" />}
          title="Carry many cards"
          desc="Add Google, KYC providers, government IDs. Use whichever fits the request."
        />
        <Feature
          icon={<ShieldCheck className="w-4 h-4" />}
          title="Disclose only what's asked"
          desc="Each presentation reveals just the claim a verifier requested. Nothing else."
        />
      </div>

      <Button
        size="lg"
        className="w-full bg-white text-black hover:bg-white/90 h-12 text-base font-medium"
        onClick={() => navigate({ to: '/register' })}
        data-testid="button-get-started"
      >
        <Fingerprint className="w-4 h-4 mr-2" />
        Get started
      </Button>
      <p className="mt-3 text-xs text-muted-foreground">
        Already have a passkey on this device?{' '}
        <button
          type="button"
          onClick={() => navigate({ to: '/login' })}
          className="underline hover:text-foreground"
        >
          Sign in
        </button>
      </p>
    </div>
  )
}

function Feature({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-3 text-left p-3 rounded-lg border border-white/10 bg-card/40">
      <span className="mt-0.5 p-1.5 rounded-md bg-white/5 text-white/80">{icon}</span>
      <div>
        <div className="text-sm font-medium text-white">{title}</div>
        <div className="text-xs text-muted-foreground">{desc}</div>
      </div>
    </div>
  )
}
