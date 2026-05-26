import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@owlid/ui/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@owlid/ui/components/ui/table'
import { openConfirmModal } from '@owlid/ui/modal'
import {
  useRevokedCredentials,
  useRevokeCredential,
  useSuspendCredential,
  useReactivateCredential,
  useCheckRevocation,
} from '~/hooks/use-verification'
import type { CheckRevocationResponse, RevocationEntry } from '@owlid/verifier-client'
import { PageHeader } from '~/components/PageHeader'
import { CopyButton } from '~/components/CopyButton'
import { StatusBadge } from '~/components/StatusBadge'
import { RelativeTime } from '~/components/RelativeTime'
import { TableSkeleton, TableError, TableEmpty } from '~/components/TableStates'

export const Route = createFileRoute('/revocations')({
  component: RevocationsPage,
})

function RevocationsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Revocations"
        description="Revoke, suspend or reactivate credentials — chain is the source of truth"
      />

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
  const [query, setQuery] = useState('')

  const entries: RevocationEntry[] = revoked.data ?? []
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) => e.credentialId.toLowerCase().includes(q) || (e.reason ?? '').toLowerCase().includes(q),
    )
  }, [entries, query])

  async function handleReactivate(credentialId: string) {
    const ok = await openConfirmModal({
      title: 'Reactivate credential',
      description: 'This credential will pass verification again. The change is written on-chain.',
      confirmLabel: 'Reactivate',
    })
    if (ok !== 'confirmed') return
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Ban className="h-5 w-5" /> Revoked Credentials
            </CardTitle>
            <CardDescription>{entries.length} revoked or suspended</CardDescription>
          </div>
          <div className="relative w-full max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by ID or reason…"
              className="pl-8"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Credential ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Revoked</TableHead>
              <TableHead className="w-[120px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {revoked.isLoading && <TableSkeleton cols={5} />}
            {revoked.isError && (
              <TableError
                colSpan={5}
                message={revoked.error?.message ?? 'Failed to load revocations'}
                onRetry={() => revoked.refetch()}
              />
            )}
            {revoked.data && filtered.length === 0 && (
              <TableEmpty
                colSpan={5}
                icon={<Ban className="h-6 w-6" />}
                title={query ? 'No matching credentials' : 'No revoked credentials'}
                description={
                  query ? 'Try a different search term.' : 'Revoked credentials will appear here.'
                }
              />
            )}
            {filtered.map((entry) => (
              <TableRow key={entry.credentialId}>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                      {entry.credentialId.slice(0, 20)}…
                    </code>
                    <CopyButton value={entry.credentialId} label="Credential ID" />
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge status={entry.status} />
                </TableCell>
                <TableCell className="text-sm">{entry.reason ?? '—'}</TableCell>
                <TableCell className="text-sm">
                  <RelativeTime value={entry.revokedAt} />
                </TableCell>
                <TableCell>
                  {entry.status.toLowerCase() !== 'active' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleReactivate(entry.credentialId)}
                      disabled={reactivate.isPending}
                    >
                      <RotateCcw className="mr-1 h-3 w-3" /> Reactivate
                    </Button>
                  )}
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

  const pending = revoke.isPending || suspend.isPending

  function resetForm() {
    setCredentialId('')
    setIssuerPublicKey('')
    setReason('')
  }

  async function submit(mode: 'revoke' | 'suspend') {
    if (!credentialId.trim() || !issuerPublicKey.trim()) {
      toast.error('Credential ID and issuer public key are required')
      return
    }
    const ok = await openConfirmModal({
      title: mode === 'revoke' ? 'Revoke credential' : 'Suspend credential',
      description:
        mode === 'revoke'
          ? 'Revocation is permanent and written on-chain. The credential will fail every future verification.'
          : 'Suspension is a temporary on-chain block. The credential can be reactivated later.',
      confirmLabel: mode === 'revoke' ? 'Revoke' : 'Suspend',
      variant: 'destructive',
    })
    if (ok !== 'confirmed') return

    const mutation = mode === 'revoke' ? revoke : suspend
    mutation.mutate(
      {
        credentialId: credentialId.trim(),
        issuerPublicKey: issuerPublicKey.trim(),
        reason: reason.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success(mode === 'revoke' ? 'Credential revoked' : 'Credential suspended')
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
          <Button onClick={() => submit('revoke')} disabled={pending} variant="destructive">
            <Ban className="mr-2 h-4 w-4" />
            {revoke.isPending ? 'Revoking…' : 'Revoke'}
          </Button>
          <Button onClick={() => submit('suspend')} disabled={pending} variant="outline">
            <Pause className="mr-2 h-4 w-4" />
            {suspend.isPending ? 'Suspending…' : 'Suspend'}
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
    if (!credentialId.trim()) {
      toast.error('Credential ID is required')
      return
    }
    check.mutate(
      { credentialId: credentialId.trim() },
      { onError: (err) => toast.error(err.message) },
    )
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
            onKeyDown={(e) => e.key === 'Enter' && handleCheck()}
          />
          <Button onClick={handleCheck} disabled={check.isPending}>
            <Search className="mr-2 h-4 w-4" /> {check.isPending ? 'Checking…' : 'Check'}
          </Button>
        </div>

        {result && (
          <div className="rounded-lg border p-4 space-y-2">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium">Status</span>
              <StatusBadge status={result.status} />
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className="font-mono break-all">{result.credentialId}</span>
              <CopyButton value={result.credentialId} label="Credential ID" />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
