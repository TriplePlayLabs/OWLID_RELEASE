import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Info, Moon, ShieldX } from 'lucide-react'
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
import { Skeleton } from '@owlid/ui/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@owlid/ui/components/ui/dialog'
import { useIssuerInfo } from '~/hooks/use-issuer'
import { getGdprApi } from '~/hooks/use-verification'
import { useMidnightStatus } from '~/hooks/use-midnight'
import type { ErasureReceipt } from '@owlid/admin-client'
import { PageHeader } from '~/components/PageHeader'
import { CopyButton } from '~/components/CopyButton'
import { StatusBadge } from '~/components/StatusBadge'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
})

function SettingsPage() {
  const issuerInfo = useIssuerInfo()
  const midnight = useMidnightStatus()

  const sidecarReachable = midnight.data?.sidecar.reachable === true
  const sidecarConnected = midnight.data?.sidecar.connected === true
  const sidecarLatency = midnight.data?.sidecar.latencyMs
  const sidecarError = midnight.data?.sidecar.error
  const sidecarStatus = sidecarConnected ? 'connected' : sidecarReachable ? 'syncing' : 'error'

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Integration status and service identity" />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Moon className="h-5 w-5" /> Midnight Sidecar
          </CardTitle>
          <CardDescription>
            Midnight is the trust, revocation and identity-anchor core. The verification service
            refuses to start without a reachable sidecar.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {midnight.isLoading && <Skeleton className="h-5 w-40" />}
          {midnight.data && (
            <>
              <div className="flex items-center gap-3">
                <StatusBadge
                  status={sidecarStatus}
                  label={
                    sidecarStatus === 'connected'
                      ? 'Connected'
                      : sidecarStatus === 'syncing'
                        ? 'Reachable, syncing'
                        : 'Unreachable'
                  }
                />
                {sidecarLatency != null && (
                  <span className="text-xs text-muted-foreground">{sidecarLatency} ms</span>
                )}
              </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span>URL</span>
                <code className="bg-muted px-1.5 py-0.5 rounded">{midnight.data.sidecarUrl}</code>
                <CopyButton value={midnight.data.sidecarUrl} label="Sidecar URL" />
              </div>
              {sidecarError && <p className="text-destructive text-xs">{sidecarError}</p>}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Info className="h-5 w-5" /> Issuer Identity
          </CardTitle>
          <CardDescription>Public identity of the connected issuer service</CardDescription>
        </CardHeader>
        <CardContent>
          {issuerInfo.isLoading && <Skeleton className="h-12 w-full max-w-md" />}
          {issuerInfo.isError && (
            <p className="text-destructive text-sm">
              Failed to fetch issuer info: {issuerInfo.error?.message}
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
                <div className="flex items-center gap-1">
                  <code className="text-xs bg-muted px-2 py-1 rounded break-all">
                    {issuerInfo.data.publicKey}
                  </code>
                  <CopyButton value={issuerInfo.data.publicKey} label="Issuer public key" />
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-destructive flex items-center gap-2">
            <ShieldX className="h-5 w-5" /> Danger Zone
          </CardTitle>
          <CardDescription>Irreversible operations</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-4">
            <div>
              <h4 className="text-sm font-medium">GDPR Data Erasure</h4>
              <p className="text-xs text-muted-foreground">
                Revoke credentials and anonymize all records for an owner public key
              </p>
            </div>
            <GdprErasureDialog />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function GdprErasureDialog() {
  const [open, setOpen] = useState(false)
  const [ownerKey, setOwnerKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<ErasureReceipt | null>(null)

  async function handleErasure() {
    if (!ownerKey.trim()) {
      toast.error('Owner public key is required')
      return
    }
    setBusy(true)
    try {
      const result = await getGdprApi().gdprErasure({ ownerPublicKey: ownerKey.trim() })
      setReceipt(result)
      setOwnerKey('')
      toast.success(
        `Erasure complete — ${result.credentialsRevoked} revoked, ${result.recordsAnonymized} anonymized`,
      )
    } catch (err) {
      toast.error(`Erasure failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      {receipt && (
        <span className="text-xs text-muted-foreground">
          Last receipt {receipt.receiptId.slice(0, 8)}…
        </span>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="destructive" size="sm">
            Erase Data
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>GDPR Data Erasure</DialogTitle>
            <DialogDescription>
              This revokes every credential and anonymizes every record tied to the owner public
              key. It cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <Label htmlFor="owner-key">Owner Public Key</Label>
            <Input
              id="owner-key"
              className="font-mono text-xs"
              placeholder="Hex-encoded owner public key"
              value={ownerKey}
              onChange={(e) => setOwnerKey(e.target.value)}
            />
          </div>
          {receipt && (
            <div className="rounded-lg border bg-muted/50 p-3 text-xs space-y-1">
              <p className="font-medium">Last erasure receipt</p>
              <p className="text-muted-foreground">Receipt ID: {receipt.receiptId}</p>
              <p className="text-muted-foreground">
                {receipt.credentialsRevoked} credentials revoked, {receipt.recordsAnonymized}{' '}
                records anonymized
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleErasure}
              disabled={busy || !ownerKey.trim()}
            >
              {busy ? 'Erasing…' : 'Erase Data'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
