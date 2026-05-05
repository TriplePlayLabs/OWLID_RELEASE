import { useState, useRef, useEffect, useCallback } from 'react'
import type { LogEntry, LogType } from '~/types/log'

export function useLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [showLogs, setShowLogs] = useState(false)
  const logsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  const addLog = useCallback((type: LogType, message: string) => {
    const entry: LogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toLocaleTimeString(),
      type,
      message,
    }
    setLogs((prev) => [...prev, entry])
  }, [])

  const clearLogs = useCallback(() => {
    setLogs([])
  }, [])

  const toggleLogs = useCallback(() => {
    setShowLogs((prev) => !prev)
  }, [])

  return {
    logs,
    showLogs,
    logsEndRef,
    addLog,
    clearLogs,
    toggleLogs,
    setShowLogs,
  }
}
