import { createFileRoute } from '@tanstack/react-router'
import { Plug, Globe } from 'lucide-react'

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Identity Providers</h1>
        <p className="text-muted-foreground">
          View configured identity verification and OIDC providers
        </p>
      </div>

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
                Configured providers for identity verification workflows
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
                  {providers.isLoading && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        Loading...
                      </TableCell>
                    </TableRow>
                  )}
                  {providers.data?.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        No identity providers configured
                      </TableCell>
                    </TableRow>
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
                            onCheckedChange={(next) => toggle.mutate({ id: p.id, enable: next })}
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
                  {oidcProviders.isLoading && (
                    <TableRow>
                      <TableCell colSpan={2} className="text-center text-muted-foreground">
                        Loading...
                      </TableCell>
                    </TableRow>
                  )}
                  {oidcProviders.data?.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={2} className="text-center text-muted-foreground">
                        No OIDC providers configured
                      </TableCell>
                    </TableRow>
                  )}
                  {oidcProviders.data?.map((p) => (
                    <TableRow key={p.providerId}>
                      <TableCell className="font-medium">{p.providerId}</TableCell>
                      <TableCell>
                        <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                          {p.issuerUrl}
                        </code>
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
