import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { Key, Plus, Trash2, Search } from 'lucide-react'
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
import { Input } from '@owlid/ui/components/ui/input'
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
import { PageHeader } from '~/components/PageHeader'
import { CopyButton } from '~/components/CopyButton'
import { StatusBadge } from '~/components/StatusBadge'
import { RelativeTime } from '~/components/RelativeTime'
import { TableSkeleton, TableError, TableEmpty } from '~/components/TableStates'

export const Route = createFileRoute('/api-keys')({
  component: ApiKeysPage,
})

const COLS = 8

function ApiKeysPage() {
  const apiKeys = useApiKeys()
  const deactivateApiKey = useDeactivateApiKey()
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = apiKeys.data ?? []
    if (!q) return list
    return list.filter(
      (k) =>
        k.name.toLowerCase().includes(q) ||
        (k.description ?? '').toLowerCase().includes(q) ||
        (k.keyPreview ?? '').toLowerCase().includes(q),
    )
  }, [apiKeys.data, query])

  async function handleCreate() {
    await openCreateApiKeyModal({})
  }

  async function handleDeactivate(id: string, name: string, preview: string | null | undefined) {
    const result = await openConfirmModal({
      title: 'Deactivate API Key',
      description: `Deactivate "${name}" (${preview ?? '—'})? Any service using this key loses access immediately.`,
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
      <PageHeader
        title="API Keys"
        description="Programmatic credentials for the verification service"
      >
        <Button onClick={handleCreate}>
          <Plus className="mr-2 h-4 w-4" /> Create Key
        </Button>
      </PageHeader>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Key className="h-5 w-5" /> Registered Keys
              </CardTitle>
              <CardDescription>
                {apiKeys.data ? `${apiKeys.data.length} keys` : 'Loading…'}
              </CardDescription>
            </div>
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search keys…"
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
              {apiKeys.isLoading && <TableSkeleton cols={COLS} />}
              {apiKeys.isError && (
                <TableError
                  colSpan={COLS}
                  message={apiKeys.error?.message ?? 'Failed to load API keys'}
                  onRetry={() => apiKeys.refetch()}
                />
              )}
              {apiKeys.data && filtered.length === 0 && (
                <TableEmpty
                  colSpan={COLS}
                  icon={<Key className="h-6 w-6" />}
                  title={query ? 'No matching keys' : 'No API keys'}
                  description={
                    query ? 'Try a different search term.' : 'Create a key to call the API.'
                  }
                  action={
                    !query && (
                      <Button size="sm" onClick={handleCreate}>
                        <Plus className="mr-2 h-4 w-4" /> Create Key
                      </Button>
                    )
                  }
                />
              )}
              {filtered.map((apiKey) => (
                <TableRow key={apiKey.id} className={apiKey.isActive ? '' : 'opacity-60'}>
                  <TableCell>
                    <p className="font-medium">{apiKey.name}</p>
                    {apiKey.description && (
                      <p className="text-xs text-muted-foreground">{apiKey.description}</p>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <code className="font-mono text-xs">{apiKey.keyPreview ?? '—'}</code>
                      {apiKey.keyPreview && (
                        <CopyButton value={apiKey.keyPreview} label="Key preview" />
                      )}
                    </div>
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
                  <TableCell className="text-sm">
                    {apiKey.lastUsedAt ? (
                      <RelativeTime value={apiKey.lastUsedAt} />
                    ) : (
                      <span className="text-muted-foreground">Never</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={apiKey.isActive ? 'active' : 'disabled'} />
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
