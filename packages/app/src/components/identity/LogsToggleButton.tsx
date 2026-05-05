import { ScrollText, X } from 'lucide-react'

interface LogsToggleButtonProps {
  showLogs: boolean
  onToggle: () => void
}

export function LogsToggleButton({ showLogs, onToggle }: LogsToggleButtonProps) {
  return (
    <button
      onClick={onToggle}
      className="fixed top-4 right-4 z-50 p-3 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 transition-all duration-200 group"
      aria-label={showLogs ? 'Hide system logs' : 'Show system logs'}
      data-testid="button-toggle-logs"
    >
      {showLogs ? (
        <X className="w-5 h-5 text-muted-foreground group-hover:text-white transition-colors" />
      ) : (
        <ScrollText className="w-5 h-5 text-muted-foreground group-hover:text-white transition-colors" />
      )}
    </button>
  )
}
