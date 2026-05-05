export type LogType = 'info' | 'success' | 'error' | 'system'

export interface LogEntry {
  id: string
  timestamp: string
  type: LogType
  message: string
}
