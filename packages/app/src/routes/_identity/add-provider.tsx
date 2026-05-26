import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Loader2, CheckCircle, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { storage } from '@owlid/sdk'
import { Button } from '@owlid/ui/components/ui/button'
import { ProviderSelector } from '~/components/identity/ProviderSelector'
import { BackLink } from '~/components/BackLink'
import { useVerifyAndIssueWithWebAuthn } from '~/hooks/use-idp-api'
import type { ProviderInfo } from '@owlid/issuer-client'
import { readAuthState } from '~/lib/auth-gate'

export const Route = createFileRoute('/_identity/add-provider')({
  beforeLoad: async () => {
    const state = await readAuthState()
    if (state.kind === 'unregistered') {
      throw redirect({ to: '/register', replace: true })
    }
    // 'unknown' (SSR) or any has-passkey state: render the page.
  },
  component: AddProviderPage,
})

function AddProviderPage() {
  const navigate = useNavigate()
  const verifyAndIssue = useVerifyAndIssueWithWebAuthn()

  // Whether there's something to go back TO. With zero cards the only
  // legal page to land on is this one — both the BackLink + Cancel
  // would otherwise navigate to /wallet, which would bounce back here
  // (route guard), trapping the user in an infinite redirect loop.
  const [hasCards, setHasCards] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    void storage.hasAnyCredential().then((v) => {
      if (!cancelled) setHasCards(v)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (verifyAndIssue.credentialData) {
      toast.success('Credential added', {
        description: `${verifyAndIssue.credentialData.providerId} verified and stored in your wallet.`,
      })
      navigate({ to: '/wallet' })
    }
  }, [verifyAndIssue.credentialData, navigate])

  const handleProviderSelect = async (provider: ProviderInfo) => {
    // Browsers block popups opened outside a user-gesture handler — for any
    // redirect-style flow (webhook_async or oidc_redirect) we have to open
    // the window synchronously here, before the async session-create call,
    // and let the hook navigate it once the URL is known.
    const isRedirectFlow =
      provider.flowType === 'webhook_async' || provider.flowType === 'oidc_redirect'
    const popup = isRedirectFlow ? window.open('', '_blank', 'popup,width=520,height=760') : null
    if (isRedirectFlow && (!popup || popup.closed)) {
      toast.error('Verification window blocked', {
        description: 'Allow popups for this site and try again.',
      })
      return
    }
    try {
      await verifyAndIssue.mutateAsync({
        providerId: provider.id,
        username: 'user',
        popup,
      })
    } catch (error) {
      popup?.close()
      console.error('Verification failed:', error)
      toast.error('Verification Failed', {
        description: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  return (
    <div className="w-full max-w-md mx-auto px-4 pt-6 pb-12">
      {hasCards && <BackLink to="/wallet" />}

      <h1 className="text-lg font-semibold text-white mb-1">Add a provider</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Pick an identity provider to add another credential to your wallet. Each provider issues its
        own card — multiple providers means stronger proofs you can compose at presentation time.
      </p>

      {verifyAndIssue.isError && (
        <div className="flex items-center gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive mb-4">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{verifyAndIssue.error?.message || 'Verification failed'}</span>
        </div>
      )}

      {verifyAndIssue.isPending ? (
        <div className="flex flex-col items-center justify-center py-12 space-y-4">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <div className="text-center">
            <p className="font-medium">Verifying your identity…</p>
            <p className="text-sm text-muted-foreground">
              {verifyAndIssue.statusMessage || 'Connecting to identity provider'}
            </p>
          </div>
        </div>
      ) : verifyAndIssue.isSuccess ? (
        <div className="flex flex-col items-center justify-center py-12 space-y-4">
          <CheckCircle className="w-8 h-8 text-green-500" />
          <p className="font-medium">Card added — opening wallet…</p>
        </div>
      ) : (
        <ProviderSelector onSelect={handleProviderSelect} disabled={verifyAndIssue.isPending} />
      )}

      {hasCards && (
        <Button
          variant="ghost"
          className="mt-6 w-full text-xs text-muted-foreground hover:text-foreground"
          onClick={() => navigate({ to: '/wallet' })}
        >
          Cancel
        </Button>
      )}
    </div>
  )
}
