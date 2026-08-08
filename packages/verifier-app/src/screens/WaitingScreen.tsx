import { useEffect, useState } from 'react'
import { IconClock, IconInfo, IconLock, IconShield } from '../icons'
import { Eyebrow, StatusPill } from '../components/common'

interface WaitingScreenProps {
  /** Free-text status from the session state machine (connecting,
   *  waiting for approval, verifying…). */
  statusMessage: string
  onCancel: () => void
}

export function WaitingScreen({ statusMessage, onCancel }: WaitingScreenProps) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="reveal w-full mx-auto max-w-[560px]">
      <div className="card card-hero text-center p-10">
        {/* Eyebrow and icon are inline-level — give each its own block
            line or they end up sharing one line box and overlapping. */}
        <div className="flex justify-center">
          <Eyebrow>Step 03 of 03 · Awaiting holder</Eyebrow>
        </div>

        <div className="flex justify-center mt-[26px] mb-1.5">
          <div className="big-icon big-icon-neutral relative">
            <span className="pulse-ring"></span>
            <span className="pulse-ring delay"></span>
            <IconShield />
          </div>
        </div>

        <h1 className="heading-1 mt-[18px]">Waiting for approval</h1>
        <p className="lede mt-2 max-w-[380px] mx-auto">
          {statusMessage ||
            'The holder is reviewing your request on their phone. This usually takes a few seconds.'}
        </p>

        <div className="mt-[18px] flex flex-wrap justify-center gap-2">
          <StatusPill kind="neutral" icon={<IconClock />}>
            {String(Math.floor(elapsed / 60)).padStart(2, '0')}:
            {String(elapsed % 60).padStart(2, '0')} elapsed
          </StatusPill>
          <StatusPill kind="neutral" icon={<IconLock />}>
            End-to-end encrypted
          </StatusPill>
        </div>

        <div className="mt-7 flex gap-2.5 justify-center">
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>

      <div className="card card-quiet mt-[18px] px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex shrink-0 items-center justify-center w-9 h-9 bg-[var(--surface-2)] text-[var(--accent)]">
            <IconInfo />
          </span>
          <div className="text-[13.5px] text-[var(--text-2)] leading-normal">
            Holders can take their time. We'll automatically time out the session after{' '}
            <strong className="text-[var(--text-1)]">2 minutes</strong>.
          </div>
        </div>
      </div>
    </div>
  )
}
