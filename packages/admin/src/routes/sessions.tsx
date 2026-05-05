import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Users, Search, Clock } from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Badge } from '~/components/ui/badge'
import { useSession } from '~/hooks/use-issuer'

export const Route = createFileRoute('/sessions')({
  component: SessionsPage,
})

function SessionsPage() {
  const [sessionId, setSessionId] = useState('')
  const [lookupId, setLookupId] = useState('')
  const session = useSession(lookupId)

  function handleLookup() {
    if (!sessionId.trim()) {
      toast.error('Enter a session ID')
      return
    }
    setLookupId(sessionId.trim())
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Issuer Sessions</h1>
        <p className="text-muted-foreground">Look up and inspect identity verification sessions</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="h-5 w-5" /> Session Lookup
          </CardTitle>
          <CardDescription>Enter a session ID to inspect its status and data</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              className="font-mono"
              placeholder="Session UUID"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
            />
            <Button onClick={handleLookup} disabled={session.isFetching}>
              <Search className="mr-2 h-4 w-4" />
              {session.isFetching ? 'Loading...' : 'Lookup'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {session.error && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-destructive text-sm">Session not found: {session.error.message}</p>
          </CardContent>
        </Card>
      )}

      {session.data && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" /> Session Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-muted-foreground text-xs">Session ID</Label>
                <p className="font-mono text-sm">{session.data.id}</p>
              </div>
              <div className="space-y-1">
                <Label className="text-muted-foreground text-xs">Status</Label>
                <div>
                  <SessionStatusBadge status={session.data.status} />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-muted-foreground text-xs">Provider</Label>
                <p className="text-sm">{session.data.providerId}</p>
              </div>
              <div className="space-y-1">
                <Label className="text-muted-foreground text-xs">Flow Type</Label>
                <p className="text-sm">{session.data.flowType}</p>
              </div>
              <div className="space-y-1">
                <Label className="text-muted-foreground text-xs">Expires At</Label>
                <p className="text-sm flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {new Date(session.data.expiresAt).toLocaleString()}
                </p>
              </div>
              <div className="space-y-1">
                <Label className="text-muted-foreground text-xs">Verified At</Label>
                <p className="text-sm">
                  {session.data.verifiedAt
                    ? new Date(session.data.verifiedAt).toLocaleString()
                    : '—'}
                </p>
              </div>
              <div className="space-y-1">
                <Label className="text-muted-foreground text-xs">Credential Issued</Label>
                <p className="text-sm">{session.data.credentialIssued ? 'Yes' : 'No'}</p>
              </div>
              <div className="space-y-1">
                <Label className="text-muted-foreground text-xs">Expired</Label>
                <p className="text-sm">{session.data.isExpired ? 'Yes' : 'No'}</p>
              </div>
            </div>

            <div>
              <Label className="text-muted-foreground text-xs">Flow State</Label>
              <div className="mt-1 rounded-lg border bg-muted/50 p-3">
                <pre className="text-xs overflow-auto whitespace-pre-wrap max-h-[300px]">
                  {JSON.stringify(session.data.flowState, null, 2)}
                </pre>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function SessionStatusBadge({ status }: { status: string }) {
  switch (status.toLowerCase()) {
    case 'pending':
      return <Badge variant="outline">Pending</Badge>
    case 'verifying':
    case 'in_progress':
      return <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20">In Progress</Badge>
    case 'verified':
    case 'completed':
      return (
        <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
          Completed
        </Badge>
      )
    case 'failed':
    case 'expired':
      return <Badge variant="destructive">{status}</Badge>
    default:
      return <Badge variant="secondary">{status}</Badge>
  }
}
