import { motion, AnimatePresence } from 'framer-motion'
import { Terminal } from 'lucide-react'
import type { LogEntry } from '~/types/log'
import type { RefObject } from 'react'

interface LogsPanelProps {
  logs: LogEntry[]
  logsEndRef: RefObject<HTMLDivElement | null>
}

export function LogsPanel({ logs, logsEndRef }: LogsPanelProps) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 100 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 100 }}
      transition={{ type: 'spring', damping: 25, stiffness: 300 }}
      className="fixed md:relative inset-0 md:inset-auto w-full md:w-1/2 lg:w-7/12 bg-black/95 md:bg-black/40 border-t md:border-t-0 md:border-l border-white/5 p-4 md:p-12 flex flex-col relative overflow-hidden min-h-[500px] z-40"
    >
      {/* Decorative Background Grid */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] opacity-20 pointer-events-none" />

      <div className="relative z-10 flex flex-col h-full max-h-[80vh] glass-panel rounded-xl overflow-hidden shadow-2xl">
        <div className="bg-white/5 px-4 py-3 border-b border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-muted-foreground" />
            <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
              System Logs
            </span>
          </div>
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500/20 border border-red-500/50" />
            <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/20 border border-yellow-500/50" />
            <div className="w-2.5 h-2.5 rounded-full bg-green-500/20 border border-green-500/50" />
          </div>
        </div>

        <div className="flex-1 p-4 overflow-y-auto font-mono text-sm space-y-2 custom-scrollbar">
          {logs.length === 0 && (
            <div className="text-muted-foreground/50 italic">Waiting for user interaction...</div>
          )}
          <AnimatePresence>
            {logs.map((log) => (
              <motion.div
                key={log.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                className="flex gap-3"
              >
                <span className="text-muted-foreground/40 shrink-0 select-none">
                  [{log.timestamp}]
                </span>
                <span
                  className={
                    log.type === 'error'
                      ? 'text-red-400'
                      : log.type === 'success'
                        ? 'text-green-400'
                        : log.type === 'system'
                          ? 'text-blue-400'
                          : 'text-gray-300'
                  }
                >
                  {log.type === 'success' && '✓ '}
                  {log.type === 'error' && '✕ '}
                  {log.message}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
          <div ref={logsEndRef} />
        </div>
      </div>
    </motion.div>
  )
}
