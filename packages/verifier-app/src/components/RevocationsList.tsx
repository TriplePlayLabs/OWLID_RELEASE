import { useEffect, useState } from 'react'
import { Ban, ListX, Loader2, RefreshCw, CircleCheck } from 'lucide-react'
import { Card, CardContent } from '@owlid/ui/components/ui/card'
import { Button } from '@owlid/ui/components/ui/button'
import { listRevoked, type RevocationEntry } from '../api'

/** Cached projection of the on-chain revocation set. Useful for the
 *  verifier dashboard to spot a flood of revocations (e.g. an issuer
 *  rotating keys) before any single user-facing verify hits it. */
export function RevocationsList() {
  const [entries, setEntries] = useState<RevocationEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function refresh() {
    setBusy(true)
    setError(null)
    try {
      const list = await listRevoked()
      list.sort((a, b) => {
        const av = a.revokedAt instanceof Date ? a.revokedAt.getTime() : 0
        const bv = b.revokedAt instanceof Date ? b.revokedAt.getTime() : 0
        return bv - av
      })
      setEntries(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load revocations')
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
              <ListX className="w-4 h-4 text-muted-foreground" />
              Recent revocations
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              The verifier sees every revocation broadcast from the chain.
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

        {entries === null && !error && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading revocations…
          </div>
        )}

        {entries && entries.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <CircleCheck className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No revocations yet — every issued credential is currently active.
            </p>
          </div>
        )}

        {entries && entries.length > 0 && (
          <ul className="divide-y divide-white/5 rounded-md border border-white/10">
            {entries.slice(0, 50).map((r) => (
              <li key={r.credentialId} className="flex items-start gap-3 px-3 py-2.5">
                <Ban className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-mono text-white/80 break-all">{r.credentialId}</p>
                  {r.reason && <p className="text-xs text-muted-foreground mt-0.5">{r.reason}</p>}
                  {r.revokedAt && (
                    <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                      {r.revokedAt instanceof Date
                        ? r.revokedAt.toLocaleString()
                        : new Date(r.revokedAt).toLocaleString()}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
