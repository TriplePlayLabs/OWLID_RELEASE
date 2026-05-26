import { Check, Loader2, X } from 'lucide-react'
import type { Step } from '../flow-types'

interface VerificationStepsProps {
  currentStep: Step
  errored?: boolean
}

type RowState = 'pending' | 'active' | 'done' | 'failed'

interface Row {
  key: string
  label: string
  state: RowState
}

/** Linear progression of the session steps. The index of a step here is
 *  used to decide whether a row is in the past (done) or future
 *  (pending) relative to where the flow currently sits. */
const STAGE_ORDER: Step[] = [
  'idle',
  'scanning',
  'connecting',
  'selecting',
  'waiting',
  'verifying',
  'result',
]

function idx(step: Step): number {
  return STAGE_ORDER.indexOf(step)
}

/** Each row is `active` only while the flow is on one of its steps,
 *  `done` once the flow has moved strictly past it, and `pending`
 *  before that. `activeIdx` is the row's position in `STAGE_ORDER`. */
const STAGES: Array<{
  key: string
  label: string
  isActive: (s: Step) => boolean
  activeIdx: number
}> = [
  {
    key: 'scan',
    label: 'Scan holder QR',
    isActive: (s) => s === 'scanning',
    activeIdx: idx('scanning'),
  },
  {
    key: 'connect',
    label: 'Open session with the holder',
    isActive: (s) => s === 'connecting' || s === 'selecting',
    activeIdx: idx('selecting'),
  },
  {
    key: 'request',
    label: 'Send credential request',
    isActive: (s) => s === 'waiting',
    activeIdx: idx('waiting'),
  },
  {
    key: 'receive',
    label: 'Receive holder proof',
    isActive: (s) => s === 'verifying',
    activeIdx: idx('verifying'),
  },
  {
    key: 'verify',
    label: 'Verify signature, issuer, revocation',
    isActive: (s) => s === 'verifying',
    activeIdx: idx('verifying'),
  },
]

function rowsFor(step: Step, errored: boolean): Row[] {
  const stepIdx = idx(step)
  return STAGES.map(({ key, label, isActive, activeIdx }) => {
    let state: RowState = 'pending'
    if (step === 'result') {
      state = 'done'
    } else if (isActive(step)) {
      state = errored ? 'failed' : 'active'
    } else if (stepIdx > activeIdx) {
      // Only steps the flow has genuinely moved past are marked done —
      // future steps stay pending (numbered, not check-marked).
      state = 'done'
    }
    return { key, label, state }
  })
}

export function VerificationSteps({ currentStep, errored }: VerificationStepsProps) {
  const rows = rowsFor(currentStep, !!errored)
  return (
    <ol className="relative space-y-3 pl-6">
      <span aria-hidden className="absolute left-[7px] top-2 bottom-2 w-px bg-white/10" />
      {rows.map((r, i) => (
        <li key={r.key} className="relative flex items-start gap-3">
          <Dot state={r.state} index={i + 1} />
          <span
            className={
              r.state === 'failed'
                ? 'text-sm font-medium text-red-300'
                : r.state === 'done'
                  ? 'text-sm font-medium text-white/80'
                  : r.state === 'active'
                    ? 'text-sm font-medium text-white'
                    : 'text-sm font-medium text-muted-foreground'
            }
          >
            {r.label}
          </span>
        </li>
      ))}
    </ol>
  )
}

function Dot({ state, index }: { state: RowState; index: number }) {
  const base =
    'absolute -left-6 top-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0 ring-2 ring-background'
  if (state === 'done') {
    return (
      <span aria-hidden className={`${base} bg-emerald-500/15 text-emerald-400`}>
        <Check className="w-2.5 h-2.5" />
      </span>
    )
  }
  if (state === 'active') {
    return (
      <span aria-hidden className={`${base} bg-white/10 text-white`}>
        <Loader2 className="w-2.5 h-2.5 animate-spin" />
      </span>
    )
  }
  if (state === 'failed') {
    return (
      <span aria-hidden className={`${base} bg-red-500/15 text-red-300`}>
        <X className="w-2.5 h-2.5" />
      </span>
    )
  }
  return (
    <span aria-hidden className={`${base} bg-white/5 text-muted-foreground`}>
      <span className="text-[9px] leading-none">{index}</span>
    </span>
  )
}
