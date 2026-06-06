import { Check, Loader2, X, MinusCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AttestProgress } from '@owlid/sdk'

type PredicateStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed'

interface PredicateRow {
  predicate: string
  /** Most recently observed progress event for this predicate. */
  latest: AttestProgress | null
  /** Wall-clock ms when this predicate's row first appeared. The elapsed
   *  timer counts up from here and is NEVER reset on sub-stage changes, so
   *  it climbs smoothly instead of snapping back to 0 each time the server
   *  pushes a new phase. */
  startedAt: number
  status: PredicateStatus
}

interface ProvingStepsProps {
  /** Latest event from `OwlWallet.present({onAttestProgress})`. */
  progress: AttestProgress | null
  /** When the wallet has moved past the prove/relay loop into the WS
   *  response leg. Flips the trailing "Sending to verifier" row active. */
  sending?: boolean
  /** When the verifier has accepted. Flips the final row done. */
  complete?: boolean
  /** When the orchestrator threw. Marks the active row as failed and
   *  surfaces the message under it. */
  errored?: boolean
  /** Optional error message to render under the failed step. */
  errorMessage?: string
}

/** Human label per stamped predicate. The verifier never sees these
 *  strings; they exist so the user doesn't read "kyc" or
 *  "unique_personhood" in the loading screen. */
const FRIENDLY_PREDICATE: Record<string, string> = {
  age: 'Age',
  kyc: 'ID check',
  residency: 'Where you live',
  email_verified: 'Verified email',
  nationality: 'Nationality',
  age_range: 'Age range',
  unique_personhood: 'Unique person',
}

function predicateTitle(p: string): string {
  return FRIENDLY_PREDICATE[p] ?? p
}

/** Human-readable label for the current sub-stage of a predicate's
 *  attestation flow. Uses the live event payload (mode for `prove`,
 *  phase for `confirming`) so the label always reflects what's
 *  actually running on the server. */
function subStageLabel(event: AttestProgress): string {
  switch (event.stage) {
    case 'check':
      return 'Checking for an existing proof'
    case 'already-attested':
      return 'Already done, reusing your proof'
    case 'snapshot':
      return 'Reading what was asked'
    case 'prove':
      return event.mode === 'proof-server'
        ? 'Creating your proof in the cloud'
        : 'Creating proof on your device'
    case 'relay':
      return 'Sending your proof'
    case 'confirming':
      switch (event.phase) {
        case 'queued':
          return 'Waiting in line'
        case 'balancing':
          return 'Preparing it'
        case 'submitting':
          return 'Recording it securely'
        case 'pending':
          return 'Almost done'
      }
      return 'Recording it securely'
    case 'attested':
      return 'Proof saved'
    case 'skip-unsupported':
      return 'This check is not supported yet'
    case 'skip-missing-attribute':
      return "Your ID doesn't include this"
    case 'skip-unsatisfiable':
      return "Your ID can't meet this request"
    case 'unlock':
      return 'Use your face or fingerprint to unlock'
    case 'sign':
      return 'Finishing your response'
  }
}

function statusFor(stage: AttestProgress['stage']): PredicateStatus {
  switch (stage) {
    case 'attested':
    case 'already-attested':
      return 'done'
    case 'skip-unsupported':
    case 'skip-missing-attribute':
    case 'skip-unsatisfiable':
      return 'skipped'
    default:
      return 'active'
  }
}

const TRAILING_KEY = '__send__'

export function ProvingSteps({
  progress,
  sending,
  complete,
  errored,
  errorMessage,
}: ProvingStepsProps) {
  // One row per stamped predicate. Order = first-seen order so the
  // UI reads top-to-bottom the same way the orchestrator processes
  // them. Repeated events for the same predicate update its existing
  // row in place rather than appending — the screen never grows past
  // "one line per predicate" regardless of how many phases the
  // orchestrator emits.
  const [rows, setRows] = useState<PredicateRow[]>([])
  const [trailing, setTrailing] = useState<{
    status: PredicateStatus
    subtitle: string
  } | null>(null)

  useEffect(() => {
    if (!progress) return
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.predicate === progress.predicate)
      const status = statusFor(progress.stage)
      const next: PredicateRow = {
        predicate: progress.predicate,
        latest: progress,
        // Set once when the row first appears; preserved across every
        // sub-stage update so the timer is one continuous count-up.
        startedAt: idx >= 0 ? prev[idx].startedAt : Date.now(),
        status,
      }
      if (idx < 0) return [...prev, next]
      const copy = [...prev]
      copy[idx] = next
      return copy
    })
  }, [progress])

  useEffect(() => {
    if (errored) {
      setTrailing({ status: 'failed', subtitle: errorMessage ?? 'Failed' })
      setRows((prev) => prev.map((r) => (r.status === 'active' ? { ...r, status: 'failed' } : r)))
      return
    }
    if (complete) {
      setTrailing({ status: 'done', subtitle: 'Accepted' })
      return
    }
    if (sending) {
      setTrailing({ status: 'active', subtitle: 'Sending securely…' })
      return
    }
    setTrailing(null)
  }, [sending, complete, errored, errorMessage])

  // Live elapsed tick. Runs continuously until the flow reaches a terminal
  // state (complete / errored) — NOT gated on a per-row "active" flag, whose
  // brief false→true flicker between sub-stages used to tear the interval down
  // and freeze the counter, then jump on restart. Tick at 500ms so the
  // displayed whole-second value advances smoothly without skips.
  const [now, setNow] = useState(() => Date.now())
  const ticking = !complete && !errored
  useEffect(() => {
    if (!ticking) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [ticking])

  if (rows.length === 0 && !trailing) {
    return (
      <div className="flex items-center gap-3 px-1 py-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>Preparing your proof…</span>
      </div>
    )
  }

  return (
    <ol className="relative space-y-3 pl-6">
      <span aria-hidden className="absolute left-[7px] top-2 bottom-2 w-px bg-white/10" />
      {rows.map((r, i) => {
        const elapsedMs = r.status === 'active' ? now - r.startedAt : 0
        const elapsed = Math.floor(elapsedMs / 1000)
        const subtitle = r.latest
          ? r.status === 'active'
            ? `${subStageLabel(r.latest)} (${elapsed}s)`
            : subStageLabel(r.latest)
          : ''
        return (
          <li key={r.predicate} className="relative flex items-start gap-3">
            <StepDot status={r.status} index={i + 1} />
            <div className="flex-1 min-w-0 -mt-0.5">
              <p
                className={
                  r.status === 'failed'
                    ? 'text-sm font-medium text-red-300'
                    : r.status === 'done'
                      ? 'text-sm font-medium text-white/90'
                      : r.status === 'skipped'
                        ? 'text-sm font-medium text-muted-foreground'
                        : 'text-sm font-medium text-white'
                }
              >
                {predicateTitle(r.predicate)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-snug truncate">
                {subtitle}
              </p>
              {r.status === 'failed' && errorMessage && (
                <p className="mt-1 text-xs text-red-300/80 leading-snug break-words">
                  {errorMessage}
                </p>
              )}
            </div>
          </li>
        )
      })}
      {trailing && (
        <li key={TRAILING_KEY} className="relative flex items-start gap-3">
          <StepDot status={trailing.status} index={rows.length + 1} />
          <div className="flex-1 min-w-0 -mt-0.5">
            <p
              className={
                trailing.status === 'failed'
                  ? 'text-sm font-medium text-red-300'
                  : trailing.status === 'done'
                    ? 'text-sm font-medium text-white/90'
                    : 'text-sm font-medium text-white'
              }
            >
              Sending your proof
            </p>
            <p className="text-xs text-muted-foreground mt-0.5 leading-snug truncate">
              {trailing.subtitle}
            </p>
          </div>
        </li>
      )}
    </ol>
  )
}

function StepDot({ status, index }: { status: PredicateStatus; index: number }) {
  const base =
    'absolute -left-6 top-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0 ring-2 ring-background'
  switch (status) {
    case 'done':
      return (
        <span aria-hidden className={`${base} bg-green-500/15 text-green-400`}>
          <Check className="w-2.5 h-2.5" />
        </span>
      )
    case 'active':
      return (
        <span aria-hidden className={`${base} bg-blue-500/15 text-blue-300`}>
          <Loader2 className="w-2.5 h-2.5 animate-spin" />
        </span>
      )
    case 'failed':
      return (
        <span aria-hidden className={`${base} bg-red-500/15 text-red-300`}>
          <X className="w-2.5 h-2.5" />
        </span>
      )
    case 'skipped':
      return (
        <span aria-hidden className={`${base} bg-white/5 text-muted-foreground`}>
          <MinusCircle className="w-2.5 h-2.5" />
        </span>
      )
    case 'pending':
    default:
      return (
        <span aria-hidden className={`${base} bg-white/5 text-muted-foreground`}>
          <span className="text-[9px] leading-none">{index}</span>
        </span>
      )
  }
}

export default ProvingSteps
