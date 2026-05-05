import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useRef, useCallback } from 'react'
import { ScrollText, RefreshCw, Wifi, WifiOff } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card'
import { Button } from '~/components/ui/button'
import { Badge } from '~/components/ui/badge'
import { Switch } from '~/components/ui/switch'
import { Label } from '~/components/ui/label'
import { ScrollArea } from '~/components/ui/scroll-area'
import { getMonitoringApi } from '~/lib/api'

export const Route = createFileRoute('/logs')({
  component: LogsPage,
})

interface LogEntry {
  timestamp: string
  type: 'revocation' | 'info' | 'error'
  message: string
  data?: string
}

function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [wsConnected, setWsConnected] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const wsRef = useRef<WebSocket | null>(null)
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
    const verificationUrl = import.meta.env.VITE_VERIFICATION_URL || 'http://localhost:8000'
    const wsUrl = verificationUrl.replace(/^http/, 'ws') + '/ws/revocations'

    try {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setWsConnected(true)
        addLog('info', 'Connected to revocation WebSocket')
      }

      ws.onmessage = (event: MessageEvent) => {
        try {
          const data: Record<string, unknown> = JSON.parse(event.data as string)
          addLog('revocation', `Revocation event: ${(data.action as string) || 'update'}`, data)
        } catch {
          addLog('revocation', event.data as string)
        }
      }

      ws.onclose = () => {
        setWsConnected(false)
        addLog('info', 'WebSocket disconnected')
      }

      ws.onerror = () => {
        setWsConnected(false)
      }
    } catch {
      setWsConnected(false)
    }

    return () => {
      wsRef.current?.close()
    }
  }, [addLog])

  async function fetchMetricsLog() {
    try {
      const resp = await getMonitoringApi().healthRaw()
      const text = await resp.raw.text()
      addLog('info', `Health check: ${text}`)
    } catch (err) {
      addLog('error', `Failed to fetch health: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs, autoScroll])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">System Logs</h1>
          <p className="text-muted-foreground">Real-time events and service metrics</p>
        </div>
        <div className="flex items-center gap-4">
          {wsConnected ? (
            <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
              <Wifi className="mr-1 h-3 w-3" /> Connected
            </Badge>
          ) : (
            <Badge variant="secondary">
              <WifiOff className="mr-1 h-3 w-3" /> Disconnected
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={fetchMetricsLog}>
            <RefreshCw className="mr-2 h-3 w-3" /> Health Check
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ScrollText className="h-5 w-5" /> Event Log
              </CardTitle>
              <CardDescription>{logs.length} entries</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="auto-scroll" checked={autoScroll} onCheckedChange={setAutoScroll} />
              <Label htmlFor="auto-scroll" className="text-sm">
                Auto-scroll
              </Label>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[500px] rounded-lg border bg-muted/30" ref={scrollRef}>
            <div className="p-4 font-mono text-xs space-y-1">
              {logs.length === 0 && (
                <p className="text-muted-foreground">
                  No log entries yet. Events will appear here in real-time.
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
                        : log.type === 'revocation'
                          ? 'text-amber-500'
                          : 'text-foreground'
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
    </div>
  )
}
