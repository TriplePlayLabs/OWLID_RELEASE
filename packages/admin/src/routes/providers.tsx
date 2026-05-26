import { createFileRoute } from '@tanstack/react-router'
import { Plug, Globe } from 'lucide-react'
import { toast } from 'sonner'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@owlid/ui/components/ui/card'
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
import { Switch } from '@owlid/ui/components/ui/switch'
import { useProviders, useOidcProviders, useToggleProvider } from '~/hooks/use-issuer'
import type { ProviderFlowType } from '@owlid/issuer-client'
import { PageHeader } from '~/components/PageHeader'
import { CopyButton } from '~/components/CopyButton'
import { TableSkeleton, TableError, TableEmpty } from '~/components/TableStates'

function flowTypeLabel(t: ProviderFlowType): string {
  switch (t) {
    case 'saml_redirect':
      return 'SAML redirect'
    case 'qr_polling':
      return 'QR + polling'
    case 'webhook_async':
      return 'Webhook async'
    case 'form_based':
      return 'Form'
    default:
      return t
  }
}

export const Route = createFileRoute('/providers')({
  component: ProvidersPage,
})

function ProvidersPage() {
  const providers = useProviders()
  const oidcProviders = useOidcProviders()
  const toggle = useToggleProvider()

  function onToggle(id: string, enable: boolean) {
    toggle.mutate(
      { id, enable },
      {
        onSuccess: () => toast.success(`Provider ${enable ? 'enabled' : 'disabled'}`),
        onError: (err) => toast.error(err.message),
      },
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Identity Providers"
        description="Identity-verification and OIDC providers wired into the issuer service"
      />

      <Tabs defaultValue="identity">
        <TabsList>
          <TabsTrigger value="identity">Identity Providers</TabsTrigger>
          <TabsTrigger value="oidc">OIDC Providers</TabsTrigger>
        </TabsList>

        <TabsContent value="identity" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plug className="h-5 w-5" /> Identity Providers
              </CardTitle>
              <CardDescription>
                Toggle a provider off to fail-close every new session that uses it
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider ID</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Enabled</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {providers.isLoading && <TableSkeleton cols={4} />}
                  {providers.isError && (
                    <TableError
                      colSpan={4}
                      message={providers.error?.message ?? 'Failed to load providers'}
                      onRetry={() => providers.refetch()}
                    />
                  )}
                  {providers.data?.length === 0 && (
                    <TableEmpty
                      colSpan={4}
                      icon={<Plug className="h-6 w-6" />}
                      title="No identity providers"
                      description="Providers are configured in the issuer service."
                    />
                  )}
                  {providers.data?.map((p) => {
                    const pending = toggle.isPending && toggle.variables?.id === p.id
                    return (
                      <TableRow key={p.id}>
                        <TableCell>
                          <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{p.id}</code>
                        </TableCell>
                        <TableCell className="font-medium">{p.name}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{flowTypeLabel(p.flowType)}</Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Switch
                            checked={p.enabled}
                            disabled={pending}
                            onCheckedChange={(next) => onToggle(p.id, next)}
                            aria-label={`Toggle provider ${p.id}`}
                          />
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="oidc" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Globe className="h-5 w-5" /> OIDC Providers
              </CardTitle>
              <CardDescription>OpenID Connect providers for authentication flows</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider ID</TableHead>
                    <TableHead>Issuer URL</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {oidcProviders.isLoading && <TableSkeleton cols={2} />}
                  {oidcProviders.isError && (
                    <TableError
                      colSpan={2}
                      message={oidcProviders.error?.message ?? 'Failed to load OIDC providers'}
                      onRetry={() => oidcProviders.refetch()}
                    />
                  )}
                  {oidcProviders.data?.length === 0 && (
                    <TableEmpty
                      colSpan={2}
                      icon={<Globe className="h-6 w-6" />}
                      title="No OIDC providers"
                      description="OIDC providers are configured in the issuer service."
                    />
                  )}
                  {oidcProviders.data?.map((p) => (
                    <TableRow key={p.providerId}>
                      <TableCell className="font-medium">{p.providerId}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                            {p.issuerUrl}
                          </code>
                          <CopyButton value={p.issuerUrl} label="Issuer URL" />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
