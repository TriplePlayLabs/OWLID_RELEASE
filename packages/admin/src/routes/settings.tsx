import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Key, Server, Copy, Eye, EyeOff, Info } from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Separator } from '~/components/ui/separator'
import { Badge } from '~/components/ui/badge'
import { useIssuerInfo, useIssuerHealth } from '~/hooks/use-issuer'
import { useVerificationHealth, getGdprApi } from '~/hooks/use-verification'
import type { ErasureReceipt } from '@owlid/sdk'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
})

function SettingsPage() {
  const issuerInfo = useIssuerInfo()
  const issuerHealth = useIssuerHealth()
  const verificationHealth = useVerificationHealth()

  const [apiKey, setApiKey] = useState(import.meta.env.VITE_API_KEY || '')
  const [showKey, setShowKey] = useState(false)

  const verificationUrl = import.meta.env.VITE_VERIFICATION_URL || 'http://localhost:8000'
  const issuerUrl = import.meta.env.VITE_ISSUER_URL || 'http://localhost:8001'

  function copyPublicKey() {
    if (issuerInfo.data) {
      navigator.clipboard.writeText(issuerInfo.data.publicKey)
      toast.success('Issuer public key copied')
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">API configuration and service information</p>
      </div>

      {/* API Key Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" /> API Key
          </CardTitle>
          <CardDescription>
            The API key used to authenticate admin requests. Set via{' '}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">VITE_API_KEY</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="api-key">Current API Key</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="api-key"
                  className="font-mono pr-10"
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="No API key configured"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full"
                  onClick={() => setShowKey(!showKey)}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(apiKey)
                  toast.success('API key copied')
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Changes here are session-only. Update the environment variable for persistence.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Service Endpoints */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" /> Service Endpoints
          </CardTitle>
          <CardDescription>
            Backend service URLs (configured via environment variables)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label>Verification Service</Label>
            <div className="flex items-center gap-2">
              <Input className="font-mono text-sm" value={verificationUrl} readOnly />
              {verificationHealth.data ? (
                <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 shrink-0">
                  Online
                </Badge>
              ) : (
                <Badge variant="destructive" className="shrink-0">
                  Offline
                </Badge>
              )}
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Issuer Service</Label>
            <div className="flex items-center gap-2">
              <Input className="font-mono text-sm" value={issuerUrl} readOnly />
              {issuerHealth.data ? (
                <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 shrink-0">
                  Online
                </Badge>
              ) : (
                <Badge variant="destructive" className="shrink-0">
                  Offline
                </Badge>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Issuer Info */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Info className="h-5 w-5" /> Issuer Information
          </CardTitle>
          <CardDescription>Current issuer service identity</CardDescription>
        </CardHeader>
        <CardContent>
          {issuerInfo.isLoading && (
            <p className="text-muted-foreground text-sm">Loading issuer info...</p>
          )}
          {issuerInfo.error && (
            <p className="text-destructive text-sm">
              Failed to fetch issuer info: {issuerInfo.error.message}
            </p>
          )}
          {issuerInfo.data && (
            <div className="space-y-3">
              <div className="grid gap-1">
                <Label className="text-muted-foreground text-xs">Name</Label>
                <p className="text-sm font-medium">{issuerInfo.data.name}</p>
              </div>
              <div className="grid gap-1">
                <Label className="text-muted-foreground text-xs">Public Key</Label>
                <div className="flex items-center gap-2">
                  <code className="text-xs bg-muted px-2 py-1 rounded break-all">
                    {issuerInfo.data.publicKey}
                  </code>
                  <Button variant="ghost" size="icon" onClick={copyPublicKey}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">Danger Zone</CardTitle>
          <CardDescription>Destructive operations that cannot be undone</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-lg border border-destructive/30 p-4">
            <div>
              <h4 className="text-sm font-medium">GDPR Data Erasure</h4>
              <p className="text-xs text-muted-foreground">
                Delete all data associated with a specific owner public key
              </p>
            </div>
            <GdprErasureButton />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function GdprErasureButton() {
  const [ownerKey, setOwnerKey] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [receipt, setReceipt] = useState<ErasureReceipt | null>(null)

  async function handleErasure() {
    if (!ownerKey.trim()) {
      toast.error('Owner public key is required')
      return
    }
    try {
      const result = await getGdprApi().gdprErasure({ ownerPublicKey: ownerKey.trim() })
      setReceipt(result)
      toast.success(
        `GDPR erasure completed: ${result.credentialsRevoked} credentials revoked, ${result.recordsAnonymized} records anonymized`,
      )
      setOwnerKey('')
      setConfirming(false)
    } catch (err) {
      toast.error(`Erasure failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!confirming) {
    return (
      <div className="flex items-center gap-2">
        {receipt && (
          <span className="text-xs text-muted-foreground">
            Last: {receipt.receiptId.slice(0, 8)}...
          </span>
        )}
        <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>
          Erase Data
        </Button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        className="font-mono text-xs w-48"
        placeholder="Owner public key"
        value={ownerKey}
        onChange={(e) => setOwnerKey(e.target.value)}
      />
      <Button variant="destructive" size="sm" onClick={handleErasure}>
        Confirm
      </Button>
      <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </div>
  )
}
