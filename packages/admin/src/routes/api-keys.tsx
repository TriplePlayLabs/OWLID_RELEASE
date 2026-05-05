import { createFileRoute } from '@tanstack/react-router'
import { Key, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@owlid/ui/components/ui/card'
import { Button } from '@owlid/ui/components/ui/button'
import { Badge } from '@owlid/ui/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@owlid/ui/components/ui/table'
import { openConfirmModal } from '@owlid/ui/modal'
import { useApiKeys, useDeactivateApiKey } from '~/hooks/use-admin'
import { Environment } from '@owlid/admin-client'
import { openCreateApiKeyModal } from '~/features/api-keys/CreateApiKeyModal'

export const Route = createFileRoute('/api-keys')({
  component: ApiKeysPage,
})

function ApiKeysPage() {
  const apiKeys = useApiKeys()
  const deactivateApiKey = useDeactivateApiKey()

  function copyPreview(text: string) {
    navigator.clipboard.writeText(text)
    toast.success('Key preview copied')
  }

  async function handleCreate() {
    await openCreateApiKeyModal({})
  }

  async function handleDeactivate(id: string, name: string, preview: string | null | undefined) {
    const result = await openConfirmModal({
      title: 'Deactivate API Key',
      description: `Deactivate "${name}" (${preview ?? '—'})? Any service using this key will lose access immediately.`,
      confirmLabel: 'Deactivate',
      variant: 'destructive',
    })
    if (result !== 'confirmed') return
    deactivateApiKey.mutate(id, {
      onSuccess: () => toast.success('API key deactivated'),
      onError: (err) => toast.error(err.message),
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">API Keys</h1>
          <p className="text-muted-foreground">
            Programmatic credentials for the verification service
          </p>
        </div>

        <Button onClick={handleCreate}>
          <Plus className="mr-2 h-4 w-4" /> Create Key
        </Button>
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
                <TableHead>Key</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Env</TableHead>
                <TableHead>Permissions</TableHead>
                <TableHead>Last Used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[50px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {apiKeys.isLoading && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    Loading...
                  </TableCell>
                </TableRow>
              )}
              {apiKeys.error && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-destructive">
                    Failed to load API keys: {apiKeys.error.message}
                  </TableCell>
                </TableRow>
              )}
              {apiKeys.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
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
                    <button
                      type="button"
                      className="font-mono text-xs hover:text-primary"
                      title="Copy preview"
                      onClick={() => copyPreview(apiKey.keyPreview ?? '')}
                    >
                      {apiKey.keyPreview ?? '—'}
                    </button>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs uppercase">
                      {apiKey.keyType}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={apiKey.environment === Environment.live ? 'default' : 'secondary'}
                      className="text-xs"
                    >
                      {apiKey.environment}
                    </Badge>
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
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => handleDeactivate(apiKey.id, apiKey.name, apiKey.keyPreview)}
                        disabled={deactivateApiKey.isPending}
                        aria-label={`Deactivate ${apiKey.name}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
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
