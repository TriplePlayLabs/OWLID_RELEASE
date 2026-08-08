import { useEffect, useMemo, useState } from 'react'
import { IconArrowLeft, IconCheck, IconShieldAlert, IconX } from '../icons'
import { Eyebrow } from '../components/common'
import { friendlyVerifyError } from '../error-messages'
import { listHistory, type HistoryRecord } from '../history-store'

type Status = 'ok' | 'denied' | 'failed'
type Filter = 'all' | 'ok' | 'denied' | 'failed'

const HISTORY_PAGE = 100

function statusOf(rec: HistoryRecord): Status {
  if (rec.valid) return 'ok'
  if (rec.error && /declin|denied|rejected/i.test(rec.error)) return 'denied'
  return 'failed'
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const isYesterday = d.toDateString() === yesterday.toDateString()
  const hhmm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return `Today · ${hhmm}`
  if (isYesterday) return `Yesterday · ${hhmm}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${hhmm}`
}

export function HistoryScreen({ onBack }: { onBack: () => void }) {
  const [records, setRecords] = useState<HistoryRecord[] | null>(null)
  const [filter, setFilter] = useState<Filter>('all')

  useEffect(() => {
    let cancelled = false
    listHistory(0, HISTORY_PAGE)
      .then((page) => {
        if (!cancelled) setRecords(page.records)
      })
      .catch(() => {
        if (!cancelled) setRecords([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const all = records ?? []
  const stats = useMemo(() => {
    const ok = all.filter((r) => statusOf(r) === 'ok').length
    const denied = all.filter((r) => statusOf(r) === 'denied').length
    const failed = all.filter((r) => statusOf(r) === 'failed').length
    const today = all.filter((r) => formatTime(r.timestamp).startsWith('Today')).length
    const rate = all.length ? Math.round((ok / all.length) * 100) : 0
    return { ok, denied, failed, today, rate }
  }, [all])

  const filtered = all.filter((r) => filter === 'all' || statusOf(r) === filter)

  return (
    <div className="reveal w-full mx-auto max-w-[980px]">
      <div className="section-head">
        <div className="left">
          <Eyebrow>Activity log</Eyebrow>
          <h1 className="heading-1">Verification history</h1>
        </div>
        <div className="right">
          <button className="btn btn-ghost btn-sm" onClick={onBack}>
            <IconArrowLeft /> Back
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3.5 mb-[22px]">
        <Stat label="Sessions today" value={stats.today} accent="var(--text-0)" />
        <Stat
          label="Pass rate"
          value={`${stats.rate}%`}
          accent="var(--success-hi)"
          sub={`last ${all.length} sessions`}
        />
        <Stat label="Declined" value={stats.denied} accent="var(--warn)" />
        <Stat label="Failed" value={stats.failed} accent="var(--danger-hi)" />
      </div>

      <div className="section-head mb-3.5">
        <div className="left">
          <h2 className="heading-2">All sessions</h2>
          <div className="muted text-[13px]">
            Records are stored locally — only session hashes leave your device.
          </div>
        </div>
        <div className="right">
          <div className="tabs">
            {(
              [
                { id: 'all', label: 'All' },
                { id: 'ok', label: 'Verified' },
                { id: 'denied', label: 'Declined' },
                { id: 'failed', label: 'Failed' },
              ] as { id: Filter; label: string }[]
            ).map((t) => (
              <button
                key={t.id}
                className={`tab ${filter === t.id ? 'active' : ''}`}
                onClick={() => setFilter(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {records === null ? (
        <div className="card card-quiet text-center text-[var(--text-3)]">Loading history…</div>
      ) : filtered.length === 0 ? (
        <div className="card card-quiet text-center text-[var(--text-3)]">
          No verifications yet.
        </div>
      ) : (
        <div className="row-list">
          {filtered.map((h) => {
            const status = statusOf(h)
            const meta =
              status === 'ok'
                ? { pill: 'success', icon: <IconCheck />, label: 'Verified' }
                : status === 'denied'
                  ? { pill: 'warn', icon: <IconShieldAlert />, label: 'Declined' }
                  : { pill: 'danger', icon: <IconX />, label: 'Failed' }
            const name = h.campaign || h.checks[0] || 'Verification'
            return (
              <div className="row" key={h.id}>
                <span className={`row-icon ${meta.pill}`}>{meta.icon}</span>
                <div className="row-main">
                  <div className="row-title">{name}</div>
                  <div className="row-sub">
                    {h.checks.length} check{h.checks.length === 1 ? '' : 's'}
                    {h.checks.length > 0 && <> · {h.checks.join(', ')}</>}
                    {h.error && (
                      <>
                        {' '}
                        ·{' '}
                        <span className="text-[var(--danger-hi)]">
                          {friendlyVerifyError(h.error) ?? h.error}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <span className="row-meta w-[130px] text-right">{formatTime(h.timestamp)}</span>
                <span className={`pill pill-${meta.pill}`}>{meta.label}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const Stat = ({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string | number
  sub?: string
  accent?: string
}) => (
  <div className="card card-quiet p-[18px]">
    <div className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--text-3)]">
      {label}
    </div>
    <div
      className="mt-1.5 text-[28px] font-semibold tracking-[-0.02em]"
      style={{ color: accent || 'var(--text-0)' }}
    >
      {value}
    </div>
    {sub && <div className="mt-0.5 text-xs text-[var(--text-3)]">{sub}</div>}
  </div>
)
