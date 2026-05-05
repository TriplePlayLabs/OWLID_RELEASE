import type { ReactNode } from 'react'
import { CheckCircle2, XCircle, AlertTriangle, Loader2, Server } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@owlid/ui/components/ui/card'
import { Badge } from '@owlid/ui/components/ui/badge'

export type ServiceState = 'loading' | 'healthy' | 'degraded' | 'unreachable' | 'disabled'

interface ServiceStatusCardProps {
  name: string
  /** Address the service is running at; rendered under the badge so it's
   *  obvious which deployment the dashboard is pointed at. */
  url?: string | null
  state: ServiceState
  /** Round-trip of the latest health probe, in ms. */
  latencyMs?: number | null
  /** Optional extra info (last error, etc.) rendered below the URL/latency. */
  detail?: string
  /** Slot for in-card actions or extended content (e.g. provider links). */
  children?: ReactNode
  icon?: ReactNode
}

const BADGE: Record<ServiceState, { label: string; className: string; Icon: typeof CheckCircle2 }> =
  {
    loading: {
      label: 'Checking…',
      className: 'bg-muted text-muted-foreground border',
      Icon: Loader2,
    },
    healthy: {
      label: 'Healthy',
      className: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
      Icon: CheckCircle2,
    },
    degraded: {
      label: 'Degraded',
      className: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
      Icon: AlertTriangle,
    },
    unreachable: {
      label: 'Unreachable',
      className: 'bg-destructive/10 text-destructive border-destructive/20',
      Icon: XCircle,
    },
    disabled: {
      label: 'Disabled',
      className: 'bg-muted text-muted-foreground border',
      Icon: AlertTriangle,
    },
  }

export function ServiceStatusCard({
  name,
  url,
  state,
  latencyMs,
  detail,
  children,
  icon,
}: ServiceStatusCardProps) {
  const { label, className, Icon } = BADGE[state]
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          {icon ?? <Server className="h-4 w-4 text-muted-foreground" />}
          {name}
        </CardTitle>
        <Badge className={className}>
          <Icon className={'mr-1 h-3 w-3' + (state === 'loading' ? ' animate-spin' : '')} />
          {label}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-1">
        <p className="text-xs font-mono text-muted-foreground break-all">{url ?? '—'}</p>
        {latencyMs != null && (
          <p className="text-xs text-muted-foreground">Latency {latencyMs} ms</p>
        )}
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
        {children}
      </CardContent>
    </Card>
  )
}
