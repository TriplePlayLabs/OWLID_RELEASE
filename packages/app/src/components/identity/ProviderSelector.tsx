/**
 * Provider Selector Component
 *
 * Fetches and displays available identity providers from the IDP API.
 * Uses TanStack Query for API state management.
 */

import { Loader2, Building2, Globe, Shield, ChevronRight } from 'lucide-react'
import { Button } from '@owlid/ui/components/ui/button'
import { useProviders } from '~/hooks/use-idp-api'
import type { ProviderInfoExtended, ProviderFlowType } from '@owlid/sdk/issuer'

interface ProviderSelectorProps {
  onSelect: (provider: ProviderInfoExtended) => void
  disabled?: boolean
}

const FLOW_TYPE_LABELS: Record<ProviderFlowType, string> = {
  form_based: 'Form',
  saml_redirect: 'Redirect',
  qr_polling: 'QR Code',
  webhook_async: 'Document Upload',
}

const FLOW_TYPE_ICONS: Record<ProviderFlowType, typeof Building2> = {
  form_based: Building2,
  saml_redirect: Globe,
  qr_polling: Shield,
  webhook_async: Shield,
}

export function ProviderSelector({ onSelect, disabled = false }: ProviderSelectorProps) {
  const { data: providers, isLoading, error, refetch } = useProviders()

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading providers...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-center py-6">
        <p className="text-sm text-destructive mb-2">{error.message}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    )
  }

  if (!providers || providers.length === 0) {
    return (
      <div className="text-center py-6">
        <p className="text-sm text-muted-foreground">No identity providers available.</p>
        <p className="text-xs text-muted-foreground mt-1">Make sure the IDP service is running.</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground mb-3">
        Select an identity provider to verify your identity:
      </p>
      {providers.map((provider) => {
        const FlowIcon = FLOW_TYPE_ICONS[provider.flowType] || Shield
        return (
          <Button
            key={provider.id}
            variant="outline"
            className="w-full justify-between h-auto py-3 px-4 hover:bg-accent/50 group"
            disabled={disabled}
            onClick={() => onSelect(provider)}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <FlowIcon className="w-5 h-5 text-primary" />
              </div>
              <div className="text-left">
                <div className="font-medium">{provider.name}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-2">
                  <span>{provider.country}</span>
                  <span className="opacity-50">•</span>
                  <span className="capitalize">
                    {FLOW_TYPE_LABELS[provider.flowType] || provider.flowType}
                  </span>
                </div>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:translate-x-1 transition-transform" />
          </Button>
        )
      })}
    </div>
  )
}
