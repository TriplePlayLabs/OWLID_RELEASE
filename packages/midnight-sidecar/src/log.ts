/**
 * Structured JSON logger for Cloud Logging.
 *
 * Cloud Run captures stdout/stderr line-by-line. If a line is valid
 * JSON with a `severity` field, Cloud Logging promotes that line into
 * the `jsonPayload` of a structured log entry — every other field
 * becomes queryable with `jsonPayload.<field>` in the log explorer.
 *
 * Usage:
 *   log.info('wallet.balance.done', { jobId, elapsedMs, txId })
 *   log.warn('wallet.state', { synced: false, lag: 120 })
 *   log.error('wallet.balance.error', { jobId, err: String(e) })
 *
 * Query in GCP:
 *   resource.type="cloud_run_revision"
 *   jsonPayload.event="wallet.balance.done"
 *   jsonPayload.jobId="abc..."
 *
 * Severities recognised by Cloud Logging: DEBUG, INFO, NOTICE, WARNING,
 * ERROR, CRITICAL, ALERT, EMERGENCY.
 */

type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR'

function emit(severity: Severity, event: string, fields: Record<string, unknown>): void {
  // bigints are not JSON-serializable; coerce them so the log entry
  // survives `JSON.stringify` without throwing.
  const safe: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    safe[k] = typeof v === 'bigint' ? v.toString() : v
  }
  const line = JSON.stringify({
    severity,
    event,
    time: new Date().toISOString(),
    ...safe,
  })
  if (severity === 'ERROR') {
    process.stderr.write(line + '\n')
  } else {
    process.stdout.write(line + '\n')
  }
}

export const log = {
  debug: (event: string, fields: Record<string, unknown> = {}): void =>
    emit('DEBUG', event, fields),
  info: (event: string, fields: Record<string, unknown> = {}): void => emit('INFO', event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}): void =>
    emit('WARNING', event, fields),
  error: (event: string, fields: Record<string, unknown> = {}): void =>
    emit('ERROR', event, fields),
}
