import { ShieldCheck, ShieldX, Trash2, Clock } from 'lucide-react'
import type { HistoryEntry } from '../App'

interface VerificationHistoryProps {
  history: HistoryEntry[]
  onClear: () => void
}

export function VerificationHistory({ history, onClear }: VerificationHistoryProps) {
  return (
    <div className="rounded-xl border border-white/10 bg-zinc-900 overflow-hidden">
      <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Clock className="w-4 h-4 text-zinc-500" />
          Recent Verifications
        </h3>
        <button
          onClick={onClear}
          className="p-1 rounded hover:bg-zinc-800 transition-colors"
          aria-label="Clear history"
        >
          <Trash2 className="w-3.5 h-3.5 text-zinc-500" />
        </button>
      </div>
      <div className="divide-y divide-white/5 max-h-60 overflow-y-auto">
        {history.map((entry) => (
          <div key={entry.id} className="px-4 py-2.5 flex items-center gap-3">
            {entry.result.valid ? (
              <ShieldCheck className="w-4 h-4 text-green-400 shrink-0" />
            ) : (
              <ShieldX className="w-4 h-4 text-red-400 shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-xs font-mono text-zinc-400 truncate">{entry.token}</p>
              <p className="text-xs text-zinc-600">
                {entry.timestamp.toLocaleTimeString()}
                {!entry.result.valid && entry.result.error && (
                  <span className="ml-2 text-red-400/70">{entry.result.error}</span>
                )}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
