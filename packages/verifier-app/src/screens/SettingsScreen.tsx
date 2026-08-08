import type { ReactNode } from 'react'
import { toast } from 'sonner'
import {
  IconArrowLeft,
  IconBadge,
  IconHistory,
  IconLock,
  IconRefresh,
  IconSound,
  IconTrash,
  IconUser,
} from '../icons'
import { Eyebrow } from '../components/common'
import { clearHistory } from '../history-store'

export interface VerifierSettings {
  autoReset: boolean
  sound: boolean
  history: boolean
  pin: boolean
}

interface SettingsScreenProps {
  displayName: string
  setDisplayName: (v: string) => void
  handle: string
  setHandle: (v: string) => void
  settings: VerifierSettings
  setSettings: (s: VerifierSettings) => void
  onResetPrefs: () => void
  onBack: () => void
}

export function SettingsScreen({
  displayName,
  setDisplayName,
  handle,
  setHandle,
  settings,
  setSettings,
  onResetPrefs,
  onBack,
}: SettingsScreenProps) {
  const toggle = (k: keyof VerifierSettings) => setSettings({ ...settings, [k]: !settings[k] })

  return (
    <div className="reveal w-full mx-auto max-w-[720px]">
      <div className="section-head">
        <div className="left">
          <Eyebrow>Verifier preferences</Eyebrow>
          <h1 className="heading-1">Settings</h1>
        </div>
        <div className="right">
          <button className="btn btn-ghost btn-sm" onClick={onBack}>
            <IconArrowLeft /> Back
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-[18px]">
        <section className="card">
          <Eyebrow>Identity</Eyebrow>
          <h2 className="heading-2 mt-2 mb-3.5">How you appear to holders</h2>

          <div className="field-label">
            <IconUser /> Display name
          </div>
          <input
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <div className="field-hint">This appears on every holder's consent screen.</div>

          <div className="mt-[18px]">
            <div className="field-label">
              <IconBadge /> Business handle
            </div>
            <input
              className="input"
              placeholder="@blueowlcafe"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
            />
            <div className="field-hint">
              A short, unique handle. Used for receipts and audit logs.
            </div>
          </div>
        </section>

        <section className="card">
          <Eyebrow>Behavior</Eyebrow>
          <h2 className="heading-2 mt-2 mb-3.5">Session defaults</h2>

          <SettingRow
            icon={<IconRefresh />}
            title="Auto-start a new session after verifying"
            sub="Skip the confirmation screen and go straight back to scan."
            on={settings.autoReset}
            onToggle={() => toggle('autoReset')}
          />
          <SettingRow
            icon={<IconSound />}
            title="Sound on result"
            sub="Subtle chime when a verification completes."
            on={settings.sound}
            onToggle={() => toggle('sound')}
          />
          <SettingRow
            icon={<IconHistory />}
            title="Keep local history"
            sub="Stores up to 500 session records on this device."
            on={settings.history}
            onToggle={() => toggle('history')}
          />
          <SettingRow
            icon={<IconLock />}
            title="Require staff PIN"
            sub="Ask for a PIN before each session. Recommended for shared kiosks."
            on={settings.pin}
            onToggle={() => toggle('pin')}
          />
        </section>

        <section className="card">
          <Eyebrow>Danger zone</Eyebrow>
          <h2 className="heading-2 mt-2 mb-3.5">Clear data</h2>
          <div className="flex gap-[10px] flex-wrap">
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                clearHistory()
                  .then(() => toast.success('History cleared'))
                  .catch(() => toast.error('Could not clear history'))
              }}
            >
              <IconTrash /> Clear history
            </button>
            <button
              className="btn btn-danger-ghost btn-sm"
              onClick={() => {
                onResetPrefs()
                toast.success('Preferences reset')
              }}
            >
              <IconTrash /> Reset all preferences
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

const SettingRow = ({
  icon,
  title,
  sub,
  on,
  onToggle,
}: {
  icon: ReactNode
  title: string
  sub: string
  on: boolean
  onToggle: () => void
}) => (
  <div className="flex items-center gap-3.5 py-3.5 border-t border-[var(--line-1)]">
    <span className="inline-flex shrink-0 items-center justify-center w-9 h-9 bg-[var(--surface-2)] text-[var(--text-1)]">
      {icon}
    </span>
    <div className="flex-1 min-w-0">
      <div className="text-sm font-semibold text-[var(--text-1)]">{title}</div>
      <div className="mt-0.5 text-[12.5px] text-[var(--text-3)]">{sub}</div>
    </div>
    <button className={`toggle ${on ? 'on' : ''}`} onClick={onToggle} aria-pressed={on}></button>
  </div>
)
