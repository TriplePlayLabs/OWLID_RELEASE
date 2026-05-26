import { Badge } from '@owlid/ui/components/ui/badge'

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

const TONE: Record<Tone, string> = {
  success: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  warning: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  danger: 'bg-destructive/10 text-destructive border-destructive/20',
  info: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  neutral: 'bg-muted text-muted-foreground border',
}

/** Maps a free-form status string to a tone. Shared by revocations,
 *  sessions and audit views so the same word always reads the same. */
function toneFor(status: string): Tone {
  switch (status.toLowerCase()) {
    case 'active':
    case 'verified':
    case 'completed':
    case 'success':
    case 'enabled':
      return 'success'
    case 'suspended':
    case 'pending':
    case 'syncing':
      return 'warning'
    case 'revoked':
    case 'failed':
    case 'expired':
    case 'error':
    case 'disabled':
      return 'danger'
    case 'verifying':
    case 'in_progress':
      return 'info'
    default:
      return 'neutral'
  }
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge className={TONE[toneFor(status)]}>{label ?? titleCase(status)}</Badge>
}
