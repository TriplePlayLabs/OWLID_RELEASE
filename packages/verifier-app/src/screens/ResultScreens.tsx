import {
  IconArrowRight,
  IconCheck,
  IconClock,
  IconInfo,
  IconKey,
  IconLock,
  IconRefresh,
  IconShieldAlert,
  IconShieldCheck,
  IconX,
} from '../icons'
import { checkById } from '../design-data'
import { Eyebrow, StatusPill } from '../components/common'
import type { VerifyResult } from '../api'

const META_KEYS = new Set(['issuerKey', 'ownerKey', 'rootHash', 'salt'])

const nowTime = (opts: Intl.DateTimeFormatOptions) => new Date().toLocaleTimeString([], opts)

// ============================================
// VERIFIED
// ============================================
export function VerifiedScreen({
  displayName,
  selected,
  result,
  onAgain,
  onDone,
}: {
  displayName: string
  selected: string[]
  result: VerifyResult
  onAgain: () => void
  onDone: () => void
}) {
  const time = nowTime({ hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const subjects = (result.subjects ?? {}) as Record<string, unknown>
  const issuerKey = typeof subjects.issuerKey === 'string' ? subjects.issuerKey : ''
  const sessionId = `vs_${new Date().toISOString().slice(0, 10)}`

  return (
    <div className="reveal w-full mx-auto max-w-[720px]">
      <div className="card card-hero text-center border-[var(--success-line)]">
        <div className="relative inline-flex mt-2">
          <div className="big-icon big-icon-success">
            <IconCheck strokeWidth={2.4} />
          </div>
        </div>

        <h1 className="heading-display mt-[18px] text-[var(--success-hi)]">Verified</h1>
        <p className="lede mt-2">
          Cryptographic proof checked out. All requested attributes match.
        </p>

        <div className="mt-[18px] flex flex-wrap justify-center gap-2">
          <StatusPill kind="success" icon={<IconShieldCheck />}>
            Issuer trusted
          </StatusPill>
          <StatusPill kind="success" icon={<IconLock />}>
            Signature valid
          </StatusPill>
          <StatusPill kind="success" icon={<IconClock />}>
            Not expired
          </StatusPill>
        </div>
      </div>

      <div className="section-head mt-7 mb-3.5">
        <div className="left">
          <Eyebrow>Result · {time}</Eyebrow>
          <h2 className="heading-2">Attributes proven</h2>
        </div>
        <div className="right">
          <span className="muted text-[13px]">
            {selected.length} of {selected.length} passed
          </span>
        </div>
      </div>

      <div className="row-list">
        {selected.map((id) => {
          const c = checkById(id)
          if (!c) return null
          return (
            <div className="row" key={id}>
              <span className="row-icon success">
                <IconCheck strokeWidth={2.4} />
              </span>
              <div className="row-main">
                <div className="row-title">{c.label}</div>
                <div className="row-sub">Proven via zero-knowledge proof · {c.group}</div>
              </div>
              <span className="pill pill-success">
                <IconCheck /> Yes
              </span>
            </div>
          )
        })}
      </div>

      <div className="card card-quiet mt-[18px]">
        <div className="section-head mb-3.5">
          <div className="left">
            <Eyebrow>Cryptographic details</Eyebrow>
            <h3 className="heading-3">Proof envelope</h3>
          </div>
        </div>

        <div className="verify-summary">
          <div className="cell">
            <div className="label">Verifier</div>
            <div className="value">{displayName || 'Verifier'}</div>
          </div>
          <div className="cell">
            <div className="label">Format</div>
            <div className="value mono">SD-JWT VC · Midnight ZK</div>
          </div>
          <div className="cell">
            <div className="label">Disclosure</div>
            <div className="value">Selective (yes/no only)</div>
          </div>
          <div className="cell">
            <div className="label">Session</div>
            <div className="value mono">{sessionId}</div>
          </div>
        </div>

        {issuerKey && (
          <div className="mt-3.5">
            <div className="field-label mb-2">
              <IconKey /> Issuer public key
            </div>
            <div className="hash">{issuerKey}</div>
          </div>
        )}
      </div>

      <div className="mt-[22px] flex flex-wrap justify-center gap-2.5">
        <button className="btn btn-secondary" onClick={onDone}>
          Close session
        </button>
        <button className="btn btn-primary btn-lg" onClick={onAgain}>
          Verify another
          <IconArrowRight />
        </button>
      </div>
    </div>
  )
}

// ============================================
// FAILED (cryptographic / session failure)
// ============================================
export function FailedScreen({
  message,
  onAgain,
  onDone,
}: {
  message: string
  onAgain: () => void
  onDone: () => void
}) {
  return (
    <div className="reveal w-full mx-auto max-w-[640px]">
      <div className="card card-hero text-center border-[var(--danger-line)]">
        <div className="big-icon big-icon-danger inline-flex mt-2 mx-auto">
          <IconX strokeWidth={2.4} />
        </div>
        <h1 className="heading-display mt-[18px] text-[var(--danger-hi)]">Could not verify</h1>
        <p className="lede mt-2 max-w-[420px] mx-auto">
          {message || 'The proof could not be verified. Do not accept this credential.'}
        </p>

        <div className="mt-[18px] flex flex-wrap justify-center gap-2">
          <StatusPill kind="danger" icon={<IconShieldAlert />}>
            Do not accept
          </StatusPill>
          <StatusPill kind="neutral" icon={<IconClock />}>
            {nowTime({ hour: '2-digit', minute: '2-digit' })}
          </StatusPill>
        </div>
      </div>

      <div className="card card-quiet mt-[18px]">
        <div className="field-label">
          <IconInfo /> What to tell the holder
        </div>
        <ul className="mt-2 pl-[18px] text-[var(--text-2)] text-sm leading-[1.7]">
          <li>Open the Owl ID wallet and check the credential status.</li>
          <li>If revoked or expired, request a fresh credential from the issuer.</li>
          <li>
            If this keeps happening, contact{' '}
            <span className="mono text-[var(--text-1)]">support@owlid.app</span>.
          </li>
        </ul>
      </div>

      <div className="mt-[22px] flex flex-wrap justify-center gap-2.5">
        <button className="btn btn-ghost" onClick={onDone}>
          Close
        </button>
        <button className="btn btn-primary" onClick={onAgain}>
          <IconRefresh /> Try again
        </button>
      </div>
    </div>
  )
}

// ============================================
// DENIED (holder said no)
// ============================================
export function DeniedScreen({ onAgain, onDone }: { onAgain: () => void; onDone: () => void }) {
  return (
    <div className="reveal w-full mx-auto max-w-[560px]">
      <div className="card card-hero text-center">
        <div className="big-icon big-icon-warn">
          <IconShieldAlert strokeWidth={2.2} />
        </div>
        <h1 className="heading-1 mt-[18px]">Request declined</h1>
        <p className="lede mt-2 max-w-[420px] mx-auto">
          The holder declined to share these attributes. No data was exchanged.
        </p>
        <div className="mt-[22px] flex flex-wrap justify-center gap-2.5">
          <button className="btn btn-ghost" onClick={onDone}>
            Close
          </button>
          <button className="btn btn-primary" onClick={onAgain}>
            <IconRefresh /> Start over
          </button>
        </div>
      </div>
    </div>
  )
}
