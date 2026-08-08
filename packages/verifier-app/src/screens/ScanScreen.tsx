import { lazy, Suspense, useState } from 'react'
import { IconArrowLeft, IconUser } from '../icons'
import { checkById } from '../design-data'
import { Eyebrow } from '../components/common'

// The scanner ships a ~1 MB zxing WASM decoder — load it only when a
// scan actually starts, not on app startup.
const Scanner = lazy(() => import('@yudiel/react-qr-scanner').then((m) => ({ default: m.Scanner })))

interface ScanScreenProps {
  displayName: string
  selected: string[]
  onScan: (data: string) => void
  onBack: () => void
}

export function ScanScreen({ displayName, selected, onScan, onBack }: ScanScreenProps) {
  const [camError, setCamError] = useState<string | null>(null)

  return (
    <div className="reveal w-full mx-auto max-w-[720px]">
      <div className="section-head">
        <div className="left">
          <Eyebrow>Step 02 of 03 · Connect</Eyebrow>
          <h1 className="heading-1">Scan the holder's wallet</h1>
        </div>
        <div className="right">
          <button className="btn btn-ghost btn-sm" onClick={onBack}>
            <IconArrowLeft /> Edit request
          </button>
        </div>
      </div>

      <div className="card card-hero">
        <div className="scanner">
          <div className="scanner-live">
            <Suspense fallback={<div className="w-full h-full" />}>
              <Scanner
                onScan={(result) => {
                  const raw = result?.[0]?.rawValue
                  if (raw) onScan(raw)
                }}
                onError={(err) =>
                  setCamError(err instanceof Error ? err.message : 'Camera unavailable')
                }
                styles={{
                  container: { width: '100%', height: '100%' },
                  video: { objectFit: 'cover' },
                }}
                components={{ torch: true, finder: false }}
              />
            </Suspense>
          </div>
          <div className="scanner-frame">
            <span></span>
          </div>
          <div className="scanner-laser"></div>
        </div>
        <div className="text-center mt-[18px]">
          <div className="heading-3 mb-1">Point at the holder's QR</div>
          <div className="muted text-[13.5px]">
            Open the Owl ID wallet and tap <strong className="text-[var(--text-2)]">Present</strong>{' '}
            to display the code.
          </div>
          {camError && (
            <div className="muted text-[12.5px] text-[var(--danger-hi)] mt-2">
              {camError} — grant camera permission and try again.
            </div>
          )}
        </div>
      </div>

      <SessionSummary displayName={displayName} selected={selected} />
    </div>
  )
}

const SessionSummary = ({ displayName, selected }: { displayName: string; selected: string[] }) => (
  <div className="card card-quiet mt-[18px] px-5 py-4 flex items-center gap-3.5 flex-wrap">
    <div className="flex items-center gap-2.5">
      <span className="inline-flex shrink-0 items-center justify-center w-7 h-7 bg-[var(--surface-2)] text-[var(--text-1)]">
        <IconUser size={14} />
      </span>
      <div>
        <div className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--text-3)]">
          Requesting as
        </div>
        <div className="text-sm text-[var(--text-1)] font-semibold">
          {displayName || 'Verifier'}
        </div>
      </div>
    </div>
    <div className="w-px h-7 bg-[var(--line-2)]"></div>
    <div className="flex items-center gap-2 flex-wrap">
      <div className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--text-3)]">
        Checks · {selected.length}
      </div>
      <div className="flex gap-1.5 flex-wrap">
        {selected.slice(0, 4).map((id) => {
          const c = checkById(id)
          if (!c) return null
          return (
            <span key={id} className="pill pill-neutral">
              {c.label}
            </span>
          )
        })}
        {selected.length > 4 && (
          <span className="pill pill-neutral">+{selected.length - 4} more</span>
        )}
      </div>
    </div>
  </div>
)
