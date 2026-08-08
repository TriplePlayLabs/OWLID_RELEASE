import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, Landmark, BadgeCheck, BadgeX } from 'lucide-react'
import { Card, CardContent } from '@owlid/ui/components/ui/card'
import { Badge } from '@owlid/ui/components/ui/badge'
import { Button } from '@owlid/ui/components/ui/button'
import { listTrustedIssuers, type TrustedIssuerInfo } from '../api'
import { formatTimestamp } from '../format'

/** Shows the verifier-service's trusted-issuer set so the operator can
 *  see (a) which issuers are accepted, (b) whether they're active. */
export function TrustedIssuersList() {
  const [items, setItems] = useState<TrustedIssuerInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function refresh() {
    setBusy(true)
    setError(null)
    try {
      setItems(await listTrustedIssuers())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load issuers')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Card className="border-white/10 bg-zinc-900/50">
      <CardContent className="space-y-3 py-5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold flex items-center gap-2">
              <Landmark className="w-4 h-4 text-muted-foreground" />
              Trusted issuers
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              Credentials are only accepted when signed by one of these keys.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={refresh} disabled={busy}>
            {busy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            <span className="ml-1.5">Refresh</span>
          </Button>
        </div>

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {items === null && !error && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading issuers…
          </div>
        )}

        {items && items.length === 0 && (
          <p className="text-sm text-muted-foreground py-4">No trusted issuers configured.</p>
        )}

        {items && items.length > 0 && (
          <ul className="divide-y divide-white/5 rounded-md border border-white/10">
            {items.map((i) => (
              <li key={i.publicKey} className="flex items-start gap-3 px-3 py-3">
                {i.isActive ? (
                  <BadgeCheck className="w-4 h-4 mt-0.5 text-emerald-400 shrink-0" />
                ) : (
                  <BadgeX className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium text-white truncate">{i.name}</p>
                    {/* Rotated keys share the same display name — a short
                        fingerprint of the pubkey gives each row a glanceable
                        unique id so the list doesn't read as duplicate bugs. */}
                    <Badge
                      variant="outline"
                      className="text-[10px] font-mono border-white/15 text-muted-foreground"
                    >
                      {i.publicKey.slice(0, 8)}
                    </Badge>
                    {!i.isActive && (
                      <Badge variant="outline" className="text-[10px] border-white/15">
                        Inactive
                      </Badge>
                    )}
                  </div>
                  {i.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">{i.description}</p>
                  )}
                  {/* Rotated keys re-register under the same display name —
                      the registration date is what tells them apart. */}
                  <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                    Key added {formatTimestamp(i.addedAt)}
                  </p>
                  <p className="text-[10px] font-mono text-muted-foreground/80 break-all mt-1">
                    {i.publicKey}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
