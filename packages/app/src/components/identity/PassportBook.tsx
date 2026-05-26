import Owl from '~/components/Owl'
import type { VerifiedClaims } from '@owlid/sdk'
import { PassportDataPage } from './PassportDataPage'

interface PassportBookProps {
  isOpen: boolean
  onToggle: () => void
  claims: VerifiedClaims
  portraitImage?: string
}

function PassportChip() {
  return (
    <svg viewBox="0 0 40 30" className="w-10 h-7">
      <rect
        x="2"
        y="2"
        width="36"
        height="26"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        className="text-amber-400/40"
      />
      <rect x="6" y="6" width="8" height="6" rx="1" className="fill-amber-400/30" />
      <rect x="16" y="6" width="8" height="6" rx="1" className="fill-amber-400/30" />
      <rect x="26" y="6" width="8" height="6" rx="1" className="fill-amber-400/30" />
      <rect x="6" y="14" width="8" height="6" rx="1" className="fill-amber-400/30" />
      <rect x="16" y="14" width="8" height="6" rx="1" className="fill-amber-400/30" />
      <rect x="26" y="14" width="8" height="6" rx="1" className="fill-amber-400/30" />
      <rect x="6" y="22" width="28" height="2" rx="1" className="fill-amber-400/20" />
    </svg>
  )
}

export function PassportBook({ isOpen, onToggle, claims, portraitImage }: PassportBookProps) {
  return (
    <div className="passport-container">
      <div className={`passport-book ${isOpen ? 'is-open' : ''}`} onClick={onToggle}>
        <div className="passport-cover">
          <div className="passport__logo-container scale-75">
            <Owl />
          </div>
          <div className="passport__title-group">
            <div className="text-xs tracking-[0.3em] text-amber-400/60 mb-1">DIGITAL</div>
            <div className="text-xl font-semibold tracking-wider text-amber-400/90">PASSPORT</div>
          </div>
          <div className="passport__chip-container">
            <PassportChip />
          </div>
        </div>
        <PassportDataPage claims={claims} portraitImage={portraitImage} />
      </div>
    </div>
  )
}
