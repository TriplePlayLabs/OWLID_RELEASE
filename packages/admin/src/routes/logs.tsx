import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { ScrollText, Wifi, WifiOff, Trash2, RefreshCw, Search } from 'lucide-react'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@owlid/ui/components/ui/card'
import { Button } from '@owlid/ui/components/ui/button'
import { Badge } from '@owlid/ui/components/ui/badge'
import { Switch } from '@owlid/ui/components/ui/switch'
import { Label } from '@owlid/ui/components/ui/label'
import { Input } from '@owlid/ui/components/ui/input'
import { ScrollArea } from '@owlid/ui/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@owlid/ui/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@owlid/ui/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@owlid/ui/components/ui/table'
import { getWsBaseUrl } from '@owlid/config'
import { useAuditEvents } from '~/hooks/use-admin'
import { PageHeader } from '~/components/PageHeader'
import { CopyButton } from '~/components/CopyButton'
import { RelativeTime } from '~/components/RelativeTime'
import { TableSkeleton, TableError, TableEmpty } from '~/components/TableStates'

export const Route = createFileRoute('/logs')({
  component: ActivityPage,
})

function ActivityPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity"
        description="Persistent audit trail and the live system event stream"
      />
      <Tabs defaultValue="audit">
        <TabsList>
          <TabsTrigger value="audit">Audit Trail</TabsTrigger>
          <TabsTrigger value="live">Live Events</TabsTrigger>
        </TabsList>
        <TabsContent value="audit" className="mt-4">
          <AuditTrail />
        </TabsContent>
        <TabsContent value="live" className="mt-4">
          <LiveEvents />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Audit trail — persistent, server-backed
// ---------------------------------------------------------------------------

const ENTITY_TYPES = ['issuer', 'revocation', 'api_key'] as const

function AuditTrail() {
  const [entityType, setEntityType] = useState<string>('all')
  const [query, setQuery] = useState('')
  const audit = useAuditEvents({
    limit: 200,
    entityType: entityType === 'all' ? undefined : entityType,
  })

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = audit.data ?? []
    if (!q) return list
    return list.filter(
      (e) =>
        e.eventType.toLowerCase().includes(q) ||
        e.entityId.toLowerCase().includes(q) ||
        (e.actor ?? '').toLowerCase().includes(q),
    )
  }, [audit.data, query])

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ScrollText className="h-5 w-5" /> Audit Trail
            </CardTitle>
            <CardDescription>
              {audit.data ? `${audit.data.length} recent events` : 'Loading…'}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select value={entityType} onValueChange={setEntityType}>
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All entities</SelectItem>
                {ENTITY_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t.replace(/_/g, ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative w-[200px]">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={() => audit.refetch()}
              aria-label="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {audit.isLoading && <TableSkeleton cols={4} />}
            {audit.isError && (
              <TableError
                colSpan={4}
                message={audit.error?.message ?? 'Failed to load audit events'}
                onRetry={() => audit.refetch()}
              />
            )}
            {audit.data && filtered.length === 0 && (
              <TableEmpty
                colSpan={4}
                icon={<ScrollText className="h-6 w-6" />}
                title={query ? 'No matching events' : 'No audit events'}
                description={
                  query
                    ? 'Try a different search term.'
                    : 'Operator actions are recorded here as they happen.'
                }
              />
            )}
            {filtered.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="font-medium">{e.eventType.replace(/_/g, ' ')}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Badge variant="outline" className="text-xs">
                      {e.entityType}
                    </Badge>
                    <code className="text-xs text-muted-foreground truncate max-w-[200px]">
                      {e.entityId}
                    </code>
                    <CopyButton value={e.entityId} label="Entity ID" />
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{e.actor ?? '—'}</TableCell>
                <TableCell className="text-sm">
                  <RelativeTime value={e.occurredAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Live events — WebSocket stream with auto-reconnect
// ---------------------------------------------------------------------------

interface LogEntry {
  timestamp: string
  type: 'event' | 'info' | 'error'
  message: string
  data?: string
}

// Event types that change system state — highlighted in the live feed.
const STATEFUL_EVENTS = new Set([
  'credential_revoked',
  'credential_suspended',
  'api_key_deactivated',
  'admin_user_deactivated',
  'gdpr_erasure',
])

function LiveEvents() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [wsConnected, setWsConnected] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  const addLog = useCallback((type: LogEntry['type'], message: string, data?: unknown) => {
    setLogs((prev) => [
      ...prev.slice(-499),
      {
        timestamp: new Date().toISOString(),
        type,
        message,
        data: data != null ? (typeof data === 'string' ? data : JSON.stringify(data)) : undefined,
      },
    ])
  }, [])

  useEffect(() => {
    // Per-run state. A shared ref would let the StrictMode double-mount's
    // first (cancelled) socket survive into the second run and reconnect,
    // producing duplicate connections + doubled log lines.
    let cancelled = false
    let attempt = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let ws: WebSocket | null = null

    function connect() {
      if (cancelled) return
      try {
        ws = new WebSocket(`${getWsBaseUrl()}/ws/events`)
      } catch {
        scheduleReconnect()
        return
      }

      ws.onopen = () => {
        attempt = 0
        setWsConnected(true)
        addLog('info', 'Connected to system event stream')
      }
      ws.onmessage = (event: MessageEvent) => {
        try {
          const data: Record<string, unknown> = JSON.parse(event.data as string)
          if (typeof data.warning === 'string') {
            addLog('info', data.warning)
            return
          }
          const kind = (data.eventType as string) || 'event'
          const entity = (data.entityType as string) ?? ''
          const id = (data.entityId as string) ?? ''
          const actor = (data.actor as string) ?? ''
          const type: LogEntry['type'] = STATEFUL_EVENTS.has(kind) ? 'event' : 'info'
          addLog(
            type,
            `${kind.replace(/_/g, ' ')}${actor ? ` by ${actor}` : ''}`,
            entity && id ? `${entity}:${id.slice(0, 24)}` : undefined,
          )
        } catch {
          addLog('info', event.data as string)
        }
      }
      ws.onclose = () => {
        setWsConnected(false)
        if (!cancelled) scheduleReconnect()
      }
      ws.onerror = () => ws?.close()
    }

    function scheduleReconnect() {
      if (cancelled) return
      // Exponential backoff capped at 30s so a long outage doesn't hammer
      // the service but still recovers without a manual refresh.
      const delay = Math.min(1000 * 2 ** attempt, 30_000)
      attempt += 1
      reconnectTimer = setTimeout(connect, delay)
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
    }
  }, [addLog])

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs, autoScroll])

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ScrollText className="h-5 w-5" /> Live Events
            </CardTitle>
            <CardDescription>
              Every system action, streamed live — {logs.length} this session
            </CardDescription>
          </div>
          <div className="flex items-center gap-3">
            {wsConnected ? (
              <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
                <Wifi className="mr-1 h-3 w-3" /> Connected
              </Badge>
            ) : (
              <Badge variant="secondary">
                <WifiOff className="mr-1 h-3 w-3" /> Reconnecting…
              </Badge>
            )}
            <div className="flex items-center gap-2">
              <Switch id="auto-scroll" checked={autoScroll} onCheckedChange={setAutoScroll} />
              <Label htmlFor="auto-scroll" className="text-sm">
                Auto-scroll
              </Label>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLogs([])}
              disabled={logs.length === 0}
            >
              <Trash2 className="mr-2 h-3 w-3" /> Clear
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[460px] rounded-lg border bg-muted/30" ref={scrollRef}>
          <div className="p-4 font-mono text-xs space-y-1">
            {logs.length === 0 && (
              <p className="text-muted-foreground">
                No events yet. System activity appears here in real time.
              </p>
            )}
            {logs.map((log, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-muted-foreground shrink-0">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span
                  className={
                    log.type === 'error'
                      ? 'text-destructive'
                      : log.type === 'event'
                        ? 'text-amber-500'
                        : 'text-muted-foreground'
                  }
                >
                  [{log.type.toUpperCase()}]
                </span>
                <span className="break-all">{log.message}</span>
                {log.data && (
                  <span className="text-muted-foreground truncate max-w-[300px]">{log.data}</span>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
