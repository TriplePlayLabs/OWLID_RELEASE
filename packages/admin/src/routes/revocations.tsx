import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Ban, RotateCcw, Pause, Search } from 'lucide-react'
import { toast } from 'sonner'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@owlid/ui/components/ui/card'
import { Button } from '@owlid/ui/components/ui/button'
import { Input } from '@owlid/ui/components/ui/input'
import { Label } from '@owlid/ui/components/ui/label'
import { Badge } from '@owlid/ui/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@owlid/ui/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@owlid/ui/components/ui/table'
import {
  useRevokedCredentials,
  useRevokeCredential,
  useSuspendCredential,
  useReactivateCredential,
  useCheckRevocation,
} from '~/hooks/use-verification'
import type { CheckRevocationResponse, RevocationEntry } from '@owlid/verifier-client'

export const Route = createFileRoute('/revocations')({
  component: RevocationsPage,
})

function RevocationsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Revocations</h1>
        <p className="text-muted-foreground">Manage credential revocation status</p>
      </div>

      <Tabs defaultValue="list">
        <TabsList>
          <TabsTrigger value="list">Revoked List</TabsTrigger>
          <TabsTrigger value="revoke">Revoke / Suspend</TabsTrigger>
          <TabsTrigger value="check">Check Status</TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="mt-4">
          <RevokedList />
        </TabsContent>
        <TabsContent value="revoke" className="mt-4">
          <RevokeForm />
        </TabsContent>
        <TabsContent value="check" className="mt-4">
          <CheckForm />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function RevokedList() {
  const revoked = useRevokedCredentials()
  const reactivate = useReactivateCredential()

  const entries: RevocationEntry[] = revoked.data ?? []

  function handleReactivate(credentialId: string) {
    reactivate.mutate(
      { credentialId },
      {
        onSuccess: () => toast.success('Credential reactivated'),
        onError: (err) => toast.error(err.message),
      },
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Ban className="h-5 w-5" /> Revoked Credentials
        </CardTitle>
        <CardDescription>{entries.length} revoked or suspended credentials</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Credential ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Revoked At</TableHead>
              <TableHead className="w-[100px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  No revoked credentials
                </TableCell>
              </TableRow>
            )}
            {entries.map((entry) => (
              <TableRow key={entry.credentialId}>
                <TableCell>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                    {entry.credentialId.slice(0, 20)}...
                  </code>
                </TableCell>
                <TableCell>
                  <StatusBadge status={entry.status} />
                </TableCell>
                <TableCell className="text-sm">{entry.reason ?? '—'}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {entry.revokedAt ? new Date(entry.revokedAt).toLocaleDateString() : '—'}
                </TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleReactivate(entry.credentialId)}
                    disabled={reactivate.isPending}
                  >
                    <RotateCcw className="mr-1 h-3 w-3" /> Reactivate
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function RevokeForm() {
  const revoke = useRevokeCredential()
  const suspend = useSuspendCredential()

  const [credentialId, setCredentialId] = useState('')
  const [issuerPublicKey, setIssuerPublicKey] = useState('')
  const [reason, setReason] = useState('')

  function resetForm() {
    setCredentialId('')
    setIssuerPublicKey('')
    setReason('')
  }

  function handleRevoke() {
    if (!credentialId || !issuerPublicKey) {
      toast.error('Credential ID and issuer public key are required')
      return
    }
    revoke.mutate(
      { credentialId, issuerPublicKey, reason: reason || undefined },
      {
        onSuccess: () => {
          toast.success('Credential revoked')
          resetForm()
        },
        onError: (err) => toast.error(err.message),
      },
    )
  }

  function handleSuspend() {
    if (!credentialId || !issuerPublicKey) {
      toast.error('Credential ID and issuer public key are required')
      return
    }
    suspend.mutate(
      { credentialId, issuerPublicKey, reason: reason || undefined },
      {
        onSuccess: () => {
          toast.success('Credential suspended')
          resetForm()
        },
        onError: (err) => toast.error(err.message),
      },
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Revoke or Suspend a Credential</CardTitle>
        <CardDescription>
          Permanently revoke or temporarily suspend a credential by its ID
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor="cred-id">Credential ID (root hash)</Label>
          <Input
            id="cred-id"
            className="font-mono"
            placeholder="Enter credential ID"
            value={credentialId}
            onChange={(e) => setCredentialId(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="issuer-key">Issuer Public Key</Label>
          <Input
            id="issuer-key"
            className="font-mono"
            placeholder="Hex-encoded issuer public key"
            value={issuerPublicKey}
            onChange={(e) => setIssuerPublicKey(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="reason">Reason (optional)</Label>
          <Input
            id="reason"
            placeholder="Reason for revocation"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <Button onClick={handleRevoke} disabled={revoke.isPending} variant="destructive">
            <Ban className="mr-2 h-4 w-4" />
            {revoke.isPending ? 'Revoking...' : 'Revoke'}
          </Button>
          <Button onClick={handleSuspend} disabled={suspend.isPending} variant="outline">
            <Pause className="mr-2 h-4 w-4" />
            {suspend.isPending ? 'Suspending...' : 'Suspend'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function CheckForm() {
  const check = useCheckRevocation()
  const [credentialId, setCredentialId] = useState('')

  function handleCheck() {
    if (!credentialId) {
      toast.error('Credential ID is required')
      return
    }
    check.mutate({ credentialId }, { onError: (err) => toast.error(err.message) })
  }

  const result: CheckRevocationResponse | undefined = check.data

  return (
    <Card>
      <CardHeader>
        <CardTitle>Check Revocation Status</CardTitle>
        <CardDescription>Look up the current status of a credential</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            className="font-mono"
            placeholder="Enter credential ID"
            value={credentialId}
            onChange={(e) => setCredentialId(e.target.value)}
          />
          <Button onClick={handleCheck} disabled={check.isPending}>
            <Search className="mr-2 h-4 w-4" /> Check
          </Button>
        </div>

        {result && (
          <div className="rounded-lg border p-4">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium">Status:</span>
              <StatusBadge status={result.status} />
            </div>
            <div className="mt-2 text-xs text-muted-foreground font-mono">
              ID: {result.credentialId}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function StatusBadge({ status }: { status: string }) {
  switch (status.toLowerCase()) {
    case 'revoked':
      return <Badge variant="destructive">Revoked</Badge>
    case 'suspended':
      return <Badge className="bg-amber-500/10 text-amber-500 border-amber-500/20">Suspended</Badge>
    case 'active':
      return (
        <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Active</Badge>
      )
    default:
      return <Badge variant="secondary">{status}</Badge>
  }
}
