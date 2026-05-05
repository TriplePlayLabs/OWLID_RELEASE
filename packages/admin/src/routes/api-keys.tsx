import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Key, Plus, Copy, Trash2, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Badge } from '~/components/ui/badge'
import { Checkbox } from '~/components/ui/checkbox'
import { Textarea } from '~/components/ui/textarea'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogClose,
} from '~/components/ui/dialog'
import { useApiKeys, useCreateApiKey, useDeactivateApiKey } from '~/hooks/use-admin'

export const Route = createFileRoute('/api-keys')({
  component: ApiKeysPage,
})

const AVAILABLE_PERMISSIONS = [
  { id: 'verify', label: 'Verify', description: 'Verify credentials and tokens' },
  { id: 'manage_issuers', label: 'Manage Issuers', description: 'Add/remove trusted issuers' },
  {
    id: 'manage_revocations',
    label: 'Manage Revocations',
    description: 'Revoke/reactivate credentials',
  },
  { id: 'admin', label: 'Admin', description: 'Full administrative access' },
]

function ApiKeysPage() {
  const apiKeys = useApiKeys()
  const createApiKey = useCreateApiKey()
  const deactivateApiKey = useDeactivateApiKey()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [permissions, setPermissions] = useState<string[]>([])
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [deactivateId, setDeactivateId] = useState<string | null>(null)

  function togglePermission(perm: string) {
    setPermissions((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm],
    )
  }

  function resetForm() {
    setName('')
    setDescription('')
    setPermissions([])
    setCreatedKey(null)
  }

  function handleCreate() {
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    if (permissions.length === 0) {
      toast.error('Select at least one permission')
      return
    }
    createApiKey.mutate(
      {
        name: name.trim(),
        description: description.trim() || undefined,
        permissions,
      },
      {
        onSuccess: (data) => {
          setCreatedKey(data.key)
          toast.success('API key created')
        },
        onError: (err) => toast.error(err.message),
      },
    )
  }

  function handleDeactivate(id: string) {
    deactivateApiKey.mutate(id, {
      onSuccess: () => {
        toast.success('API key deactivated')
        setDeactivateId(null)
      },
      onError: (err) => toast.error(err.message),
    })
  }

  function copyKey(key: string) {
    navigator.clipboard.writeText(key)
    toast.success('API key copied to clipboard')
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">API Keys</h1>
          <p className="text-muted-foreground">
            Manage API keys for programmatic access to the verification service
          </p>
        </div>

        <Dialog
          open={createDialogOpen}
          onOpenChange={(open) => {
            setCreateDialogOpen(open)
            if (!open) resetForm()
          }}
        >
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" /> Create Key
            </Button>
          </DialogTrigger>
          <DialogContent>
            {createdKey ? (
              <>
                <DialogHeader>
                  <DialogTitle>API Key Created</DialogTitle>
                  <DialogDescription>
                    Copy and save this key now. It will not be shown again.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="flex items-center gap-2 p-3 rounded-md bg-amber-500/10 border border-amber-500/20 text-sm text-amber-500">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>Save this key -- it will not be shown again.</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs bg-muted px-3 py-2 rounded break-all font-mono select-all">
                      {createdKey}
                    </code>
                    <Button variant="outline" size="icon" onClick={() => copyKey(createdKey)}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    onClick={() => {
                      setCreateDialogOpen(false)
                      resetForm()
                    }}
                  >
                    Done
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>Create API Key</DialogTitle>
                  <DialogDescription>
                    Generate a new API key with specific permissions.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="key-name">Name</Label>
                    <Input
                      id="key-name"
                      placeholder="e.g. Production Backend"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="key-description">Description</Label>
                    <Textarea
                      id="key-description"
                      placeholder="Optional description"
                      className="text-sm"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>Permissions</Label>
                    <div className="space-y-3">
                      {AVAILABLE_PERMISSIONS.map((perm) => (
                        <div key={perm.id} className="flex items-start gap-3">
                          <Checkbox
                            id={`perm-${perm.id}`}
                            checked={permissions.includes(perm.id)}
                            onCheckedChange={() => togglePermission(perm.id)}
                          />
                          <div className="grid gap-0.5">
                            <label
                              htmlFor={`perm-${perm.id}`}
                              className="text-sm font-medium cursor-pointer"
                            >
                              {perm.label}
                            </label>
                            <p className="text-xs text-muted-foreground">{perm.description}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="outline">Cancel</Button>
                  </DialogClose>
                  <Button onClick={handleCreate} disabled={createApiKey.isPending}>
                    {createApiKey.isPending ? 'Creating...' : 'Create Key'}
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" /> Registered Keys
          </CardTitle>
          <CardDescription>
            {apiKeys.data ? `${apiKeys.data.length} keys registered` : 'Loading...'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Permissions</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last Used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[50px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {apiKeys.isLoading && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    Loading...
                  </TableCell>
                </TableRow>
              )}
              {apiKeys.error && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-destructive">
                    Failed to load API keys: {apiKeys.error.message}
                  </TableCell>
                </TableRow>
              )}
              {apiKeys.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No API keys registered
                  </TableCell>
                </TableRow>
              )}
              {apiKeys.data?.map((apiKey) => (
                <TableRow key={apiKey.id}>
                  <TableCell>
                    <div>
                      <p className="font-medium">{apiKey.name}</p>
                      {apiKey.description && (
                        <p className="text-xs text-muted-foreground">{apiKey.description}</p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {apiKey.permissions.map((perm) => (
                        <Badge key={perm} variant="secondary" className="text-xs">
                          {perm}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(apiKey.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {apiKey.lastUsedAt ? new Date(apiKey.lastUsedAt).toLocaleDateString() : 'Never'}
                  </TableCell>
                  <TableCell>
                    {apiKey.isActive ? (
                      <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
                        Active
                      </Badge>
                    ) : (
                      <Badge variant="secondary">Inactive</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {apiKey.isActive && (
                      <Dialog
                        open={deactivateId === apiKey.id}
                        onOpenChange={(open) => setDeactivateId(open ? apiKey.id : null)}
                      >
                        <DialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Deactivate API Key</DialogTitle>
                            <DialogDescription>
                              Are you sure you want to deactivate the key "{apiKey.name}"? This
                              action cannot be undone. Any services using this key will lose access.
                            </DialogDescription>
                          </DialogHeader>
                          <DialogFooter>
                            <DialogClose asChild>
                              <Button variant="outline">Cancel</Button>
                            </DialogClose>
                            <Button
                              variant="destructive"
                              onClick={() => handleDeactivate(apiKey.id)}
                              disabled={deactivateApiKey.isPending}
                            >
                              {deactivateApiKey.isPending ? 'Deactivating...' : 'Deactivate'}
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    )}
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
