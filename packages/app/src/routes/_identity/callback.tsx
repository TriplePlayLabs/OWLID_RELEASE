/**
 * Provider redirect callback.
 *
 * The flow ALWAYS opens the IdP in a popup (window.open from
 * /create-identity); this route only ever runs in the popup tab. Its sole
 * job is to:
 *   1. Tell the issuer to pull the verification result from the provider
 *      (POST /sessions/{id}/complete — unauthenticated; session_id is the
 *      capability).
 *   2. Close itself.
 *
 * Credential issuance happens on the original /create-identity tab where
 * the session token still lives in memory.
 */

import { createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle, Loader2, XCircle } from 'lucide-react'
import { Card, CardContent } from '@owlid/ui/components/ui/card'
import { sessionsApi } from '~/lib/api'
import Owl from '~/components/Owl'

export const Route = createFileRoute('/_identity/callback')({
  validateSearch: (search: Record<string, unknown>) => ({
    session: (search.session as string) || '',
    error: (search.error as string) || undefined,
  }),
  component: CallbackPage,
})

function CallbackLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full flex flex-col items-center justify-center py-8 px-4 animate-in fade-in duration-500">
      <div className="mb-8 flex flex-col items-center">
        <Owl />
        <h1 className="text-2xl md:text-3xl font-bold tracking-tighter uppercase mt-2">Owl ID</h1>
      </div>
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">{children}</CardContent>
      </Card>
    </div>
  )
}

function CallbackPage() {
  const { session: sessionId, error: errorParam } = Route.useSearch()

  // Kick the server-side completion. The result body is ignored — the
  // origin tab polls the same endpoint and finishes the flow there.
  const completion = useQuery({
    queryKey: ['callback-complete', sessionId],
    queryFn: () => sessionsApi.completeVerification({ id: sessionId }),
    enabled: !!sessionId && !errorParam,
    retry: 1,
  })

  // Auto-close when we're done (success OR final error). Side effect, not
  // data fetching — useEffect is the right primitive here.
  useEffect(() => {
    if (errorParam || completion.isSuccess || completion.isError) {
      const t = setTimeout(() => {
        try {
          window.close()
        } catch {
          /* user blocked window.close — leave the static success message */
        }
      }, 800)
      return () => clearTimeout(t)
    }
  }, [errorParam, completion.isSuccess, completion.isError])

  if (errorParam) {
    return (
      <CallbackLayout>
        <div className="flex flex-col items-center text-center space-y-4">
          <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
            <XCircle className="h-8 w-8 text-destructive" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold">Verification failed</h2>
            <p className="text-muted-foreground text-sm">{decodeURIComponent(errorParam)}</p>
            <p className="text-muted-foreground text-xs">You can close this tab.</p>
          </div>
        </div>
      </CallbackLayout>
    )
  }

  if (!sessionId) {
    return (
      <CallbackLayout>
        <div className="flex flex-col items-center text-center space-y-4">
          <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
            <XCircle className="h-8 w-8 text-destructive" />
          </div>
          <p className="text-muted-foreground text-sm">No session reference in URL.</p>
        </div>
      </CallbackLayout>
    )
  }

  if (completion.isPending) {
    return (
      <CallbackLayout>
        <div className="flex flex-col items-center text-center space-y-4">
          <Loader2 className="h-12 w-12 animate-spin text-primary" />
          <p className="text-muted-foreground text-sm">Finalising verification…</p>
        </div>
      </CallbackLayout>
    )
  }

  return (
    <CallbackLayout>
      <div className="flex flex-col items-center text-center space-y-4">
        <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center">
          <CheckCircle className="h-8 w-8 text-green-500" />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">Verification complete</h2>
          <p className="text-muted-foreground text-sm">
            You can close this tab and return to the original Owl ID window.
          </p>
        </div>
      </div>
    </CallbackLayout>
  )
}
