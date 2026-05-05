import { ShieldCheck, ShieldX, Trash2, Clock } from 'lucide-react'
import type { HistoryEntry } from '../App'
import { Button } from '@owlid/ui/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@owlid/ui/components/ui/card'

interface VerificationHistoryProps {
  history: HistoryEntry[]
  onClear: () => void
}

export function VerificationHistory({ history, onClear }: VerificationHistoryProps) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Clock className="h-4 w-4 text-muted-foreground" />
          Recent Verifications
        </CardTitle>
        <Button variant="ghost" size="icon" onClick={onClear} aria-label="Clear history">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </CardHeader>
      <CardContent className="max-h-60 overflow-y-auto p-0">
        <ul className="divide-y">
          {history.map((entry) => (
            <li key={entry.id} className="flex items-center gap-3 px-4 py-2.5">
              {entry.result.valid ? (
                <ShieldCheck className="h-4 w-4 shrink-0 text-green-400" />
              ) : (
                <ShieldX className="h-4 w-4 shrink-0 text-red-400" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs text-muted-foreground">{entry.token}</p>
                <p className="text-xs text-muted-foreground">
                  {entry.timestamp.toLocaleTimeString()}
                  {!entry.result.valid && entry.result.error && (
                    <span className="ml-2 text-red-400/70">{entry.result.error}</span>
                  )}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
