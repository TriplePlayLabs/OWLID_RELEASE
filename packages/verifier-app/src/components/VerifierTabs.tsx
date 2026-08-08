import { ScanLine, Landmark, CircleSlash, History } from 'lucide-react'

export type Tab = 'verify' | 'issuers' | 'revocations' | 'history'

interface VerifierTabsProps {
  active: Tab
  onChange: (t: Tab) => void
}

const TABS: Array<{ id: Tab; label: string; icon: typeof ScanLine }> = [
  { id: 'verify', label: 'Verify', icon: ScanLine },
  { id: 'issuers', label: 'Trusted issuers', icon: Landmark },
  { id: 'revocations', label: 'Revocations', icon: CircleSlash },
  { id: 'history', label: 'History', icon: History },
]

/** Top-of-page tab strip. Pill-style, full-width on mobile and tight on
 *  desktop. Mirrors the holder app's segmented controls. */
export function VerifierTabs({ active, onChange }: VerifierTabsProps) {
  return (
    <nav className="w-full">
      <div className="mx-auto max-w-3xl px-2">
        <ul className="flex items-center gap-1 rounded-full border border-white/10 bg-zinc-900/50 p-1">
          {TABS.map(({ id, label, icon: Icon }) => {
            const isActive = id === active
            return (
              <li key={id} className="flex-1">
                <button
                  type="button"
                  onClick={() => onChange(id)}
                  className={`flex w-full items-center justify-center gap-2 rounded-full px-3 py-2 text-xs font-medium transition-colors ${
                    isActive
                      ? 'bg-white/10 text-white shadow-[0_0_18px_-8px_rgba(255,255,255,0.4)]'
                      : 'text-muted-foreground hover:text-white hover:bg-white/5'
                  }`}
                  aria-current={isActive ? 'page' : undefined}
                  aria-label={label}
                  title={label}
                >
                  <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">{label}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </nav>
  )
}
