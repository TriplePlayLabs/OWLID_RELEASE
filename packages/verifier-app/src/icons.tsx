// ============================================
// OwlID Verifier — Icons & brand mark
// Faithful port of the Claude Design handoff icon set: consistent
// 24×24 grid, 1.75 stroke, rounded caps/joins, currentColor.
// ============================================

import type { CSSProperties, ReactNode, SVGProps } from 'react'

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number
  strokeWidth?: number
  style?: CSSProperties
  children?: ReactNode
}

const Icon = ({ children, size = 18, strokeWidth = 1.75, style, ...rest }: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={style}
    {...rest}
  >
    {children}
  </svg>
)

type P = Omit<IconProps, 'children'>

// ============================================
// OwlMark — the brand logo (CSS-only owl from wallet.owlid.app)
// Native size is 150px; scale via CSS transform and clip the box.
// ============================================
const NATIVE_OWL_SIZE = 150

export const OwlMark = ({ size = 32, className }: { size?: number; className?: string }) => {
  const scale = size / NATIVE_OWL_SIZE
  const innerStyle: CSSProperties =
    scale === 1 ? {} : { transform: `scale(${scale})`, transformOrigin: 'top left' }
  return (
    <div
      className={`owl-mark${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
    >
      <div className="owl-container" style={innerStyle}>
        <div className="owl">
          <div className="owl-wings">
            <div className="owl-wing owl-wing-left"></div>
            <div className="owl-wing owl-wing-right"></div>
          </div>
          <div className="owl-body">
            <div className="owl-abdomen"></div>
          </div>
          <div className="owl-head">
            <div className="owl-eyes">
              <div className="owl-eye owl-eye-left">
                <div className="owl-eye-core"></div>
              </div>
              <div className="owl-eye owl-eye-right">
                <div className="owl-eye-core"></div>
              </div>
            </div>
            <div className="owl-beak"></div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================
// Icon set
// ============================================

export const IconScan = (p: P) => (
  <Icon {...p}>
    <path d="M4 8.5V6.5a2.5 2.5 0 0 1 2.5-2.5H8.5" />
    <path d="M15.5 4H17.5A2.5 2.5 0 0 1 20 6.5V8.5" />
    <path d="M20 15.5V17.5A2.5 2.5 0 0 1 17.5 20H15.5" />
    <path d="M8.5 20H6.5A2.5 2.5 0 0 1 4 17.5V15.5" />
    <path d="M4.5 12H19.5" />
  </Icon>
)

export const IconClipboard = (p: P) => (
  <Icon {...p}>
    <rect x="9" y="3" width="6" height="3.5" rx="1" />
    <path d="M9 4.75H7A2 2 0 0 0 5 6.75V19A2 2 0 0 0 7 21H17A2 2 0 0 0 19 19V6.75A2 2 0 0 0 17 4.75H15" />
  </Icon>
)

export const IconMail = (p: P) => (
  <Icon {...p}>
    <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
    <path d="M4 7L12 13L20 7" />
  </Icon>
)

export const IconCheck = (p: P) => (
  <Icon {...p}>
    <path d="M4.5 12.5L9.5 17.5L19.5 7" />
  </Icon>
)

export const IconX = (p: P) => (
  <Icon {...p}>
    <path d="M6 6L18 18" />
    <path d="M18 6L6 18" />
  </Icon>
)

export const IconArrowRight = (p: P) => (
  <Icon {...p}>
    <path d="M4 12H20" />
    <path d="M13.5 5.5L20 12L13.5 18.5" />
  </Icon>
)

export const IconArrowLeft = (p: P) => (
  <Icon {...p}>
    <path d="M20 12H4" />
    <path d="M10.5 5.5L4 12L10.5 18.5" />
  </Icon>
)

export const IconShield = (p: P) => (
  <Icon {...p}>
    <path d="M12 3L4.5 5.75V12.25C4.5 16.75 7.5 19.5 12 21C16.5 19.5 19.5 16.75 19.5 12.25V5.75L12 3Z" />
  </Icon>
)

export const IconShieldCheck = (p: P) => (
  <Icon {...p}>
    <path d="M12 3L4.5 5.75V12.25C4.5 16.75 7.5 19.5 12 21C16.5 19.5 19.5 16.75 19.5 12.25V5.75L12 3Z" />
    <path d="M8.75 12L11 14.25L15.25 10" />
  </Icon>
)

export const IconShieldAlert = (p: P) => (
  <Icon {...p}>
    <path d="M12 3L4.5 5.75V12.25C4.5 16.75 7.5 19.5 12 21C16.5 19.5 19.5 16.75 19.5 12.25V5.75L12 3Z" />
    <path d="M12 8V13" />
    <circle cx="12" cy="16" r="0.5" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconKey = (p: P) => (
  <Icon {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="M10.83 12.17L20 3" />
    <path d="M16 7L19 10" />
    <path d="M14 9L17 12" />
  </Icon>
)

export const IconHistory = (p: P) => (
  <Icon {...p}>
    <path d="M3.5 12A8.5 8.5 0 1 0 6.5 5.5" />
    <path d="M3 3.5V8H7.5" />
    <path d="M12 7.5V12L15 14" />
  </Icon>
)

export const IconSettings = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="2.75" />
    <path d="M19.43 12.98C19.47 12.66 19.5 12.34 19.5 12C19.5 11.66 19.47 11.34 19.43 11.02L21.54 9.37C21.73 9.22 21.78 8.95 21.66 8.73L19.66 5.27C19.54 5.05 19.27 4.97 19.05 5.05L16.56 6.05C16.04 5.65 15.48 5.32 14.87 5.07L14.49 2.42C14.46 2.18 14.25 2 14 2H10C9.75 2 9.54 2.18 9.51 2.42L9.13 5.07C8.52 5.32 7.96 5.66 7.44 6.05L4.95 5.05C4.73 4.97 4.46 5.05 4.34 5.27L2.34 8.73C2.22 8.95 2.27 9.22 2.46 9.37L4.57 11.02C4.53 11.34 4.5 11.67 4.5 12C4.5 12.33 4.53 12.66 4.57 12.98L2.46 14.63C2.27 14.78 2.22 15.05 2.34 15.27L4.34 18.73C4.46 18.95 4.73 19.03 4.95 18.95L7.44 17.95C7.96 18.35 8.52 18.68 9.13 18.93L9.51 21.58C9.54 21.82 9.75 22 10 22H14C14.25 22 14.46 21.82 14.49 21.58L14.87 18.93C15.48 18.68 16.04 18.34 16.56 17.95L19.05 18.95C19.27 19.03 19.54 18.95 19.66 18.73L21.66 15.27C21.78 15.05 21.73 14.78 21.54 14.63L19.43 12.98Z" />
  </Icon>
)

export const IconUser = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M4.5 20.5C5.5 16.5 8.5 14.5 12 14.5C15.5 14.5 18.5 16.5 19.5 20.5" />
  </Icon>
)

export const IconCake = (p: P) => (
  <Icon {...p}>
    <path d="M12 2.5V5" />
    <circle cx="12" cy="2.5" r="0.5" fill="currentColor" stroke="none" />
    <path d="M5 21V13.5A2 2 0 0 1 7 11.5H17A2 2 0 0 1 19 13.5V21" />
    <path d="M5 16.5C6 16.5 6.5 17.5 8 17.5C9.5 17.5 10 16.5 12 16.5C14 16.5 14.5 17.5 16 17.5C17.5 17.5 18 16.5 19 16.5" />
    <path d="M3.5 21H20.5" />
  </Icon>
)

export const IconFlag = (p: P) => (
  <Icon {...p}>
    <path d="M4.5 21V3.5" />
    <path d="M4.5 4H17L15.5 8L17 12H4.5" />
  </Icon>
)

export const IconBadge = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="9" r="5.5" />
    <path d="M9.5 13.5L8 21L12 19L16 21L14.5 13.5" />
    <path d="M10 9L11.25 10.25L14 7.5" />
  </Icon>
)

export const IconWifi = (p: P) => (
  <Icon {...p}>
    <path d="M4.5 12A11 11 0 0 1 19.5 12" />
    <path d="M8 15A6 6 0 0 1 16 15" />
    <circle cx="12" cy="18.5" r="1" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconMenu = (p: P) => (
  <Icon {...p}>
    <path d="M4 7H20" />
    <path d="M4 12H20" />
    <path d="M4 17H20" />
  </Icon>
)

export const IconRefresh = (p: P) => (
  <Icon {...p}>
    <path d="M20.5 12A8.5 8.5 0 1 1 17.5 5.5" />
    <path d="M21 3.5V8H16.5" />
  </Icon>
)

export const IconCopy = (p: P) => (
  <Icon {...p}>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
    <path d="M15.5 8.5V5.5A2 2 0 0 0 13.5 3.5H5.5A2 2 0 0 0 3.5 5.5V13.5A2 2 0 0 0 5.5 15.5H8.5" />
  </Icon>
)

export const IconBeer = (p: P) => (
  <Icon {...p}>
    <path d="M6 9.5H15V19.5A1.5 1.5 0 0 1 13.5 21H7.5A1.5 1.5 0 0 1 6 19.5V9.5Z" />
    <path d="M15 11H17A2.5 2.5 0 0 1 17 16H15" />
    <path d="M8 9.5V6.5A2 2 0 0 1 10 4.5A2 2 0 0 1 12 6.5" />
    <path d="M12 9.5V5A2 2 0 0 1 14 3" />
    <path d="M8.5 13V18" />
    <path d="M11 13V18" />
  </Icon>
)

export const IconBuilding = (p: P) => (
  <Icon {...p}>
    <rect x="4.5" y="3" width="15" height="18" rx="1.5" />
    <path d="M9 7.5H9.5" />
    <path d="M14.5 7.5H15" />
    <path d="M9 11H9.5" />
    <path d="M14.5 11H15" />
    <path d="M10 21V17H14V21" />
  </Icon>
)

export const IconLock = (p: P) => (
  <Icon {...p}>
    <rect x="4.5" y="11" width="15" height="10" rx="2" />
    <path d="M8 11V7.5A4 4 0 0 1 16 7.5V11" />
    <circle cx="12" cy="16" r="1" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconEye = (p: P) => (
  <Icon {...p}>
    <path d="M2.5 12C2.5 12 5.5 5.5 12 5.5C18.5 5.5 21.5 12 21.5 12C21.5 12 18.5 18.5 12 18.5C5.5 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
)

export const IconClock = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12L15 14" />
  </Icon>
)

export const IconFilter = (p: P) => (
  <Icon {...p}>
    <path d="M4 5H20" />
    <path d="M7 12H17" />
    <path d="M10 19H14" />
  </Icon>
)

export const IconInfo = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11V16" />
    <circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconBolt = (p: P) => (
  <Icon {...p}>
    <path d="M13.5 2.5L4 13.5H11L10.5 21.5L20 10.5H13L13.5 2.5Z" />
  </Icon>
)

export const IconSearch = (p: P) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20L15.65 15.65" />
  </Icon>
)

export const IconTrash = (p: P) => (
  <Icon {...p}>
    <path d="M4 6.5H20" />
    <path d="M9.5 6.5V4.5A1 1 0 0 1 10.5 3.5H13.5A1 1 0 0 1 14.5 4.5V6.5" />
    <path d="M6 6.5L7 19.5A1.5 1.5 0 0 0 8.5 21H15.5A1.5 1.5 0 0 0 17 19.5L18 6.5" />
    <path d="M10 11V17" />
    <path d="M14 11V17" />
  </Icon>
)

export const IconSound = (p: P) => (
  <Icon {...p}>
    <path d="M11 4.5L6 9H3V15H6L11 19.5V4.5Z" />
    <path d="M15 9.5C16 10.5 16 13.5 15 14.5" />
    <path d="M17.5 7C19.5 9 19.5 15 17.5 17" />
  </Icon>
)
