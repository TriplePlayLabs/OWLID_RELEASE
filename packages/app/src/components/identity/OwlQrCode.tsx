/**
 * OwlQrCode — single styled QR primitive used everywhere in the holder
 * app. Centralises:
 *   - scan-friendly defaults (high error correction so a center logo
 *     doesn't break decoding, generous quiet zone, hard black/white
 *     contrast for cameras at distance + odd angles)
 *   - branded center owl logo
 *   - container chrome (rounded white card, subtle ring) so every QR
 *     looks the same in every modal/screen
 *   - payload-capacity handling: long payloads drop the logo and step
 *     down the ECC level to fit; payloads beyond any QR capacity render
 *     a copy-to-clipboard fallback instead of crashing the app
 *
 * Why ECC level H: the spec allows ~30% of the modules to be damaged or
 * obscured and still decode. Anything less and the centered owl mark
 * starts producing scan failures on real phones in real lighting.
 */

import { Component, useState, type ReactNode } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Copy, FileWarning } from 'lucide-react'
import { Button } from '@owlid/ui/components/ui/button'
import { cn } from '@owlid/ui/lib/utils'
import { toast } from 'sonner'

// Version-40 byte-mode capacities per ECC level (ISO/IEC 18004 table 7).
// qrcode.react throws `RangeError: Data too long` past these — the exact
// crash from the QA report — so we route around them instead.
export const QR_BYTE_CAPACITY = { L: 2953, M: 2331, Q: 1663, H: 1273 } as const

export type QrEccLevel = keyof typeof QR_BYTE_CAPACITY

/** Pick the strongest ECC level whose byte-mode capacity fits the
 *  payload, or null when no QR version can hold it. Exported for tests. */
export function qrLevelFor(byteLength: number): QrEccLevel | null {
  if (byteLength <= QR_BYTE_CAPACITY.H) return 'H'
  if (byteLength <= QR_BYTE_CAPACITY.Q) return 'Q'
  if (byteLength <= QR_BYTE_CAPACITY.M) return 'M'
  if (byteLength <= QR_BYTE_CAPACITY.L) return 'L'
  return null
}

export interface OwlQrCodeProps {
  /** Raw QR payload (already-encoded engagement, compact token, URL, …). */
  value: string
  /** Rendered side length in CSS pixels. Default 280 — large enough that
   *  each module stays above the ~4px scanner floor even for high
   *  versions (long payloads). Bump for full-screen kiosk use. */
  size?: number
  /** Show the owl logo overlay. Default true. Disable for tiny renders
   *  where a logo would push the QR over the 30% ECC tolerance. */
  showLogo?: boolean
  /** Tighten the surrounding card for compact contexts. Default false. */
  compact?: boolean
  /** Extra classes on the outer container. */
  className?: string
  /** Accessible label — defaults to "QR code". */
  ariaLabel?: string
}

function CopyFallback({ value, compact }: { value: string; compact: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Copy failed — long-press the text below to copy manually')
    }
  }
  return (
    <div className={cn('space-y-3 text-center', compact ? 'p-1' : 'p-2')}>
      <FileWarning className="w-6 h-6 mx-auto text-amber-600" />
      <p className="text-sm text-zinc-700">
        This proof is too large to display as a QR code. Copy it and paste it into the verifier
        instead.
      </p>
      <Button variant="outline" size="sm" onClick={copy} data-testid="button-qr-copy-fallback">
        {copied ? (
          <>
            <Check className="w-3.5 h-3.5 mr-1.5" />
            Copied
          </>
        ) : (
          <>
            <Copy className="w-3.5 h-3.5 mr-1.5" />
            Copy proof
          </>
        )}
      </Button>
      <div className="max-h-24 overflow-y-auto font-mono text-[10px] text-zinc-500 break-all select-all text-left">
        {value}
      </div>
    </div>
  )
}

/** Last-resort guard: if the encoder still throws (capacity table drift,
 *  unexpected encoding mode), show the copy fallback locally instead of
 *  letting the error reach the app-level boundary and white-screen the
 *  whole wallet mid-presentation. */
class QrEncodeBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function OwlQrCode({
  value,
  size = 280,
  showLogo = true,
  compact = false,
  className,
  ariaLabel = 'QR code',
}: OwlQrCodeProps) {
  // Logo footprint at ~22% of QR side — well under the H-level 30%
  // damage tolerance even with quiet zone trimming.
  const logoSize = Math.round(size * 0.22)
  const byteLength = new TextEncoder().encode(value).length
  const level = qrLevelFor(byteLength)
  // Below H-level ECC there is no headroom for the excavated logo.
  const logoFits = level === 'H'
  const fallback = <CopyFallback value={value} compact={compact} />
  return (
    <div
      className={cn(
        'bg-white rounded-2xl shadow-sm ring-1 ring-black/5 flex items-center justify-center',
        compact ? 'p-3' : 'p-5',
        className,
      )}
      role="img"
      aria-label={ariaLabel}
    >
      {level === null ? (
        fallback
      ) : (
        <QrEncodeBoundary fallback={fallback}>
          <QRCodeSVG
            value={value}
            size={size}
            // Quiet zone: spec mandates 4 modules; qrcode.react treats
            // marginSize as module units. Keep at 2 because the surrounding
            // white card already provides physical quiet space.
            marginSize={2}
            level={level}
            bgColor="#ffffff"
            fgColor="#0B0D12"
            imageSettings={
              showLogo && logoFits
                ? {
                    src: '/favicon.svg',
                    height: logoSize,
                    width: logoSize,
                    // Excavate clears modules under the logo so the renderer
                    // doesn't try to draw black-on-logo. The H ECC level
                    // recovers the cleared modules during decode.
                    excavate: true,
                  }
                : undefined
            }
          />
        </QrEncodeBoundary>
      )}
    </div>
  )
}
