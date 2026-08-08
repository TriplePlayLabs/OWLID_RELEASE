// Shared presentational building blocks for the verifier screens.
import type { ReactNode } from 'react'
import {
  IconBadge,
  IconBeer,
  IconBuilding,
  IconCake,
  IconEye,
  IconFlag,
  IconLock,
  IconMail,
  IconShield,
  OwlMark,
} from '../icons'
import { checkById, type CheckIconKey } from '../design-data'

export type PillKind = 'neutral' | 'success' | 'danger' | 'warn'

export const StatusPill = ({
  kind = 'neutral',
  icon,
  children,
}: {
  kind?: PillKind
  icon?: ReactNode
  children: ReactNode
}) => (
  <span className={`pill pill-${kind}`}>
    {icon}
    {children}
  </span>
)

export const Eyebrow = ({ children, color }: { children: ReactNode; color?: string }) => (
  <span className="eyebrow">
    <span
      className="dot"
      style={color ? { background: color, boxShadow: `0 0 0 3px ${color}30` } : undefined}
    ></span>
    {children}
  </span>
)

export const iconFor = (key: CheckIconKey | string): ReactNode => {
  const map: Record<string, ReactNode> = {
    cake: <IconCake />,
    flag: <IconFlag />,
    badge: <IconBadge />,
    building: <IconBuilding />,
    beer: <IconBeer />,
    lock: <IconLock />,
    mail: <IconMail />,
  }
  return map[key] ?? <IconShield />
}

// ============================================
// Consent preview (right rail) — the holder's-eye view of the request
// ============================================
export const ConsentPreview = ({
  displayName,
  selected,
}: {
  displayName: string
  selected: string[]
}) => (
  <aside className="card card-quiet p-[18px] sticky top-24">
    <div className="flex items-center justify-between mb-3.5">
      <Eyebrow>Holder's view</Eyebrow>
      <StatusPill kind="neutral" icon={<IconEye />}>
        Live preview
      </StatusPill>
    </div>

    <div className="border border-[var(--line-2)] bg-gradient-to-b from-[var(--bg-1)] to-[var(--bg-0)] p-4">
      <div className="text-center mb-4">
        <div className="w-12 h-12 mx-auto mb-2.5">
          <OwlMark size={48} />
        </div>
        <div className="font-mono text-[11.5px] uppercase tracking-[0.08em] text-[var(--text-3)]">
          Verification request
        </div>
        <div className="mt-1 text-[17px] font-semibold tracking-[-0.01em] text-[var(--text-0)]">
          {displayName || 'Verifier'}{' '}
          <span className="font-normal text-[var(--text-3)]">asks to verify</span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 mb-3.5">
        {selected.length === 0 ? (
          <div className="py-4 text-center text-[12.5px] text-[var(--text-4)]">
            No checks selected yet
          </div>
        ) : (
          selected.map((id) => {
            const c = checkById(id)
            if (!c) return null
            return (
              <div
                key={id}
                className="flex items-center gap-2.5 border border-[var(--line-1)] bg-[var(--bg-2)] px-3 py-2.5"
              >
                <span className="inline-flex items-center justify-center w-[22px] h-[22px] bg-[var(--surface-2)] text-[var(--accent)]">
                  {iconFor(c.icon)}
                </span>
                <span className="text-[13px] font-medium text-[var(--text-1)]">{c.label}</span>
                <span className="ml-auto font-mono text-[10.5px] uppercase tracking-[0.05em] text-[var(--text-3)]">
                  Yes / No
                </span>
              </div>
            )
          })
        )}
      </div>

      <div className="flex gap-2">
        <button className="flex-1 py-[11px] text-[13.5px] font-semibold cursor-default border border-[var(--line-2)] bg-[var(--surface-2)] text-[var(--text-2)]">
          Deny
        </button>
        <button className="flex-1 py-[11px] text-[13.5px] font-semibold cursor-default border-0 bg-[var(--accent)] text-[var(--accent-ink)]">
          Approve
        </button>
      </div>

      <div className="mt-3.5 text-center text-[11px] text-[var(--text-4)]">
        Only yes/no answers are shared. Your data never leaves this device.
      </div>
    </div>
  </aside>
)
