import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { ShieldCheck, Plus, Search } from 'lucide-react'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@owlid/ui/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogClose,
} from '@owlid/ui/components/ui/dialog'
import { Textarea } from '@owlid/ui/components/ui/textarea'
import { useTrustedIssuers, useAddTrustedIssuer } from '~/hooks/use-verification'
import { PageHeader } from '~/components/PageHeader'
import { CopyButton } from '~/components/CopyButton'
import { StatusBadge } from '~/components/StatusBadge'
import { TableSkeleton, TableError, TableEmpty } from '~/components/TableStates'

export const Route = createFileRoute('/issuers')({
  component: IssuersPage,
})

const HEX_RE = /^[0-9a-fA-F]+$/

function IssuersPage() {
  const issuers = useTrustedIssuers()
  const addIssuer = useAddTrustedIssuer()

  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [description, setDescription] = useState('')
  const [issuerUrl, setIssuerUrl] = useState('')
  const [query, setQuery] = useState('')

  const keyError =
    publicKey.length > 0 && !HEX_RE.test(publicKey.trim()) ? 'Public key must be hex-encoded' : null

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = issuers.data ?? []
    if (!q) return list
    return list.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.publicKey.toLowerCase().includes(q) ||
        (i.description ?? '').toLowerCase().includes(q),
    )
  }, [issuers.data, query])

  function handleAdd() {
    if (!name.trim() || !publicKey.trim()) {
      toast.error('Name and public key are required')
      return
    }
    if (keyError) {
      toast.error(keyError)
      return
    }
    addIssuer.mutate(
      {
        publicKey: publicKey.trim(),
        name: name.trim(),
        description: description.trim() || undefined,
        issuerUrl: issuerUrl.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success('Trusted issuer added')
          setName('')
          setPublicKey('')
          setDescription('')
          setIssuerUrl('')
          setOpen(false)
        },
        onError: (err) => toast.error(err.message),
      },
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trusted Issuers"
        description="Issuer public keys trusted for credential verification — anchored on Midnight"
      >
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" /> Add Issuer
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Trusted Issuer</DialogTitle>
              <DialogDescription>
                Register an issuer public key as trusted. This writes to the Midnight trust
                registry.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  placeholder="e.g. DigiD Production"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="publicKey">Public Key (hex)</Label>
                <Textarea
                  id="publicKey"
                  placeholder="Issuer's public key in hex encoding"
                  className="font-mono text-xs"
                  value={publicKey}
                  onChange={(e) => setPublicKey(e.target.value)}
                  aria-invalid={keyError != null}
                />
                {keyError && <p className="text-xs text-destructive">{keyError}</p>}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  placeholder="Optional description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="issuerUrl">Issuer URL</Label>
                <Input
                  id="issuerUrl"
                  placeholder="https://issuer.example.com"
                  value={issuerUrl}
                  onChange={(e) => setIssuerUrl(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button onClick={handleAdd} disabled={addIssuer.isPending || keyError != null}>
                {addIssuer.isPending ? 'Adding…' : 'Add Issuer'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </PageHeader>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5" /> Registered Issuers
              </CardTitle>
              <CardDescription>
                {issuers.data ? `${issuers.data.length} registered` : 'Loading…'}
              </CardDescription>
            </div>
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search issuers…"
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
                <TableHead>Name</TableHead>
                <TableHead>Public Key</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {issuers.isLoading && <TableSkeleton cols={4} />}
              {issuers.isError && (
                <TableError
                  colSpan={4}
                  message={issuers.error?.message ?? 'Failed to load issuers'}
                  onRetry={() => issuers.refetch()}
                />
              )}
              {issuers.data && filtered.length === 0 && (
                <TableEmpty
                  colSpan={4}
                  icon={<ShieldCheck className="h-6 w-6" />}
                  title={query ? 'No matching issuers' : 'No trusted issuers'}
                  description={
                    query
                      ? 'Try a different search term.'
                      : 'Add an issuer public key to start verifying credentials.'
                  }
                />
              )}
              {filtered.map((issuer) => (
                <TableRow key={issuer.publicKey}>
                  <TableCell className="font-medium">{issuer.name}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                        {issuer.publicKey.slice(0, 16)}…
                      </code>
                      <CopyButton value={issuer.publicKey} label="Public key" />
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {issuer.description ?? '—'}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={issuer.isActive ? 'active' : 'disabled'} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
