import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { ShieldCheck, Plus, Copy } from 'lucide-react'
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

export const Route = createFileRoute('/issuers')({
  component: IssuersPage,
})

function IssuersPage() {
  const issuers = useTrustedIssuers()
  const addIssuer = useAddTrustedIssuer()

  const [name, setName] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [description, setDescription] = useState('')
  const [issuerUrl, setIssuerUrl] = useState('')

  function handleAdd() {
    if (!name || !publicKey) {
      toast.error('Name and public key are required')
      return
    }
    addIssuer.mutate(
      {
        publicKey,
        name,
        description: description || undefined,
        issuerUrl: issuerUrl || undefined,
      },
      {
        onSuccess: () => {
          toast.success('Trusted issuer added')
          setName('')
          setPublicKey('')
          setDescription('')
          setIssuerUrl('')
        },
        onError: (err) => toast.error(err.message),
      },
    )
  }

  function copyKey(key: string) {
    navigator.clipboard.writeText(key)
    toast.success('Public key copied')
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Trusted Issuers</h1>
          <p className="text-muted-foreground">
            Manage which issuer public keys are trusted for credential verification
          </p>
        </div>

        <Dialog>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" /> Add Issuer
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Trusted Issuer</DialogTitle>
              <DialogDescription>
                Register a new issuer public key as trusted in the verification service.
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
                />
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
              <Button onClick={handleAdd} disabled={addIssuer.isPending}>
                {addIssuer.isPending ? 'Adding...' : 'Add Issuer'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" /> Registered Issuers
          </CardTitle>
          <CardDescription>
            {issuers.data ? `${issuers.data.length} issuers registered` : 'Loading...'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Public Key</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[50px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {issuers.isLoading && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    Loading...
                  </TableCell>
                </TableRow>
              )}
              {issuers.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    No trusted issuers registered
                  </TableCell>
                </TableRow>
              )}
              {issuers.data?.map((issuer) => (
                <TableRow key={issuer.publicKey}>
                  <TableCell className="font-medium">{issuer.name}</TableCell>
                  <TableCell>
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                      {issuer.publicKey.slice(0, 16)}...
                    </code>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {issuer.description ?? '—'}
                  </TableCell>
                  <TableCell>
                    {issuer.isActive ? (
                      <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
                        Active
                      </Badge>
                    ) : (
                      <Badge variant="secondary">Inactive</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" onClick={() => copyKey(issuer.publicKey)}>
                      <Copy className="h-4 w-4" />
                    </Button>
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
