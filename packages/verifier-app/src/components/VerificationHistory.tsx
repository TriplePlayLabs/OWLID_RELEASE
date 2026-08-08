import { useCallback, useEffect, useState } from 'react'
import { CircleCheck, CircleX, Trash2, History, ChevronLeft, ChevronRight } from 'lucide-react'
import { Badge } from '@owlid/ui/components/ui/badge'
import { Button } from '@owlid/ui/components/ui/button'
import { Card, CardContent } from '@owlid/ui/components/ui/card'
import { clearHistory, listHistory, type HistoryRecord } from '../history-store'
import { friendlyVerifyError } from '../error-messages'
import { formatTimestamp } from '../format'

const PAGE_SIZE = 8

/** History tab — paged view over the IndexedDB-backed verification log. */
export function VerificationHistory() {
  const [page, setPage] = useState(0)
  const [records, setRecords] = useState<HistoryRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (p: number) => {
    setLoading(true)
    try {
      const { records, total } = await listHistory(p * PAGE_SIZE, PAGE_SIZE)
      setRecords(records)
      setTotal(total)
    } catch {
      setRecords([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(page)
  }, [page, load])

  const onClear = async () => {
    await clearHistory()
    setPage(0)
    load(0)
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  if (!loading && total === 0) {
    return (
      <Card className="border-white/10 bg-zinc-900/50">
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          No verifications yet. Switch to <span className="font-medium text-white">Verify</span> and
          scan a holder QR to log one.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <History className="h-4 w-4 text-muted-foreground" />
            Verification history
            <span className="text-xs font-normal text-muted-foreground">({total})</span>
          </h3>
          <Button variant="ghost" size="icon" onClick={onClear} aria-label="Clear history">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
        <ul className="divide-y border-t">
          {records.map((entry) => (
            <li key={entry.id} className="flex items-start gap-3 px-4 py-3">
              {entry.valid ? (
                <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-green-400" />
              ) : (
                <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
              )}
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm">
                  {entry.valid
                    ? entry.campaign
                      ? `Unique person verified for ${entry.campaign}`
                      : 'Verified'
                    : 'Verification failed'}
                </p>
                {entry.valid && entry.checks.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {entry.checks.map((c) => (
                      <Badge
                        key={c}
                        variant="outline"
                        className="border-white/15 text-[10px] font-normal text-muted-foreground"
                      >
                        {c}
                      </Badge>
                    ))}
                  </div>
                )}
                {!entry.valid && entry.error && (
                  <p className="text-xs text-red-400/80">{friendlyVerifyError(entry.error)}</p>
                )}
                <p className="text-xs text-muted-foreground">{formatTimestamp(entry.timestamp)}</p>
              </div>
            </li>
          ))}
        </ul>

        {pageCount > 1 && (
          <div className="flex items-center justify-between border-t px-4 py-2.5">
            <Button
              variant="ghost"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Newer
            </Button>
            <span className="text-xs text-muted-foreground">
              Page {page + 1} of {pageCount}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={page >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            >
              Older
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
