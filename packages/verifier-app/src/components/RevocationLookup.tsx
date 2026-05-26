import { useState } from 'react'
import { SearchCheck, CheckCircle2, AlertTriangle, Loader2, ScanLine, X } from 'lucide-react'
import { Button } from '@owlid/ui/components/ui/button'
import { Input } from '@owlid/ui/components/ui/input'
import { Card, CardContent } from '@owlid/ui/components/ui/card'
import { toast } from 'sonner'
import { checkRevocation, type CheckRevocationResponse } from '../api'
import { QrScanner } from './QrScanner'

/** Verifier-facing revocation lookup. Paste OR scan any credential id —
 *  the SDK's `SdJwtVc.credentialIdHex()` produces the hex form; any QR
 *  encoding the raw id works too. */
export function RevocationLookup() {
  const [credentialId, setCredentialId] = useState('')
  const [result, setResult] = useState<CheckRevocationResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)

  async function runLookup(id: string) {
    const trimmed = id.trim()
    if (!trimmed) {
      toast.error('Paste a credential id first')
      return
    }
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const r = await checkRevocation(trimmed)
      setResult(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lookup failed')
    } finally {
      setBusy(false)
    }
  }

  function onScan(data: string) {
    // QR can encode the id directly, or wrap it in a tiny JSON envelope
    // (`{ credentialId: "…" }`) — accept both so verifiers don't need to
    // worry about the producer side.
    let value = data.trim()
    if (value.startsWith('{')) {
      try {
        const parsed = JSON.parse(value)
        if (typeof parsed?.credentialId === 'string') value = parsed.credentialId.trim()
      } catch {
        /* fall through — try as raw string */
      }
    }
    setCredentialId(value)
    setScanning(false)
    if (value) {
      void runLookup(value)
    }
  }

  const status = result?.status
  const isActive = status === 'active'
  const isRevoked = status === 'revoked'

  if (scanning) {
    return (
      <Card className="border-white/10 bg-zinc-900/50">
        <CardContent className="py-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-semibold flex items-center gap-2">
              <ScanLine className="w-4 h-4 text-muted-foreground" />
              Scan a credential QR
            </h3>
            <Button variant="ghost" size="sm" onClick={() => setScanning(false)}>
              <X className="w-3.5 h-3.5 mr-1" />
              Close
            </Button>
          </div>
          <QrScanner onScan={onScan} onCancel={() => setScanning(false)} />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-white/10 bg-zinc-900/50">
      <CardContent className="space-y-4 py-5">
        <div>
          <h3 className="text-base font-semibold flex items-center gap-2">
            <SearchCheck className="w-4 h-4 text-muted-foreground" />
            Check a credential
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Paste a credential id or scan its QR to see whether it has been revoked on Midnight.
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={credentialId}
            onChange={(e) => setCredentialId(e.target.value)}
            placeholder="Paste a credential ID"
            className="font-mono text-xs"
            spellCheck={false}
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runLookup(credentialId)
            }}
          />
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setScanning(true)} disabled={busy}>
              <ScanLine className="w-4 h-4" />
              <span className="ml-1">Scan</span>
            </Button>
            <Button onClick={() => runLookup(credentialId)} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Check'}
            </Button>
          </div>
        </div>

        {result && (
          <div
            className={`flex items-start gap-3 rounded-md border px-3 py-2.5 ${
              isActive ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-red-500/30 bg-red-500/5'
            }`}
          >
            {isActive ? (
              <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-400 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 mt-0.5 text-red-400 shrink-0" />
            )}
            <div className="min-w-0">
              <p
                className={`text-sm font-medium ${isActive ? 'text-emerald-300' : 'text-red-300'}`}
              >
                {isActive
                  ? 'Active — credential is not revoked'
                  : isRevoked
                    ? 'Revoked'
                    : `Status: ${status}`}
              </p>
              <p className="text-[11px] text-muted-foreground font-mono mt-1 break-all">
                {result.credentialId}
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
