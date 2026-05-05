import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Copy, Info, Loader2, Moon } from 'lucide-react'
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
import { Separator } from '@owlid/ui/components/ui/separator'
import { Switch } from '@owlid/ui/components/ui/switch'
import { useIssuerInfo } from '~/hooks/use-issuer'
import { getGdprApi } from '~/hooks/use-verification'
import { useMidnightStatus, useToggleMidnight } from '~/hooks/use-midnight'
import type { ErasureReceipt } from '@owlid/admin-client'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
})

function SettingsPage() {
  const issuerInfo = useIssuerInfo()
  const midnight = useMidnightStatus()
  const toggleMidnight = useToggleMidnight()

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
        <p className="text-muted-foreground">Integration controls and service identity</p>
      </div>

      {/* Midnight runtime toggle — admin-only, persisted to system_settings */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Moon className="h-5 w-5" /> Midnight Integration
            </CardTitle>
            <CardDescription>
              Gate chain-bound operations. Disabling stops on-chain calls but preserves the
              connection so re-enabling is instant.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {toggleMidnight.isPending && (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            )}
            <Switch
              checked={midnight.data?.enabled ?? false}
              disabled={
                !midnight.data?.configured || midnight.isLoading || toggleMidnight.isPending
              }
              onCheckedChange={(next) => toggleMidnight.mutate(next)}
              aria-label="Toggle Midnight integration"
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {!midnight.data?.configured && (
            <p className="text-muted-foreground">
              The verification service was started without{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">MIDNIGHT_SIDECAR_URL</code>.
              Set the env and restart the service to make this toggle functional.
            </p>
          )}
          {toggleMidnight.isError && (
            <p className="text-destructive text-xs">
              {toggleMidnight.error instanceof Error
                ? toggleMidnight.error.message
                : 'Toggle failed'}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Persisted to <code className="text-xs">system_settings.midnight_enabled</code> so
            restarts inherit the last operator decision.
          </p>
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
