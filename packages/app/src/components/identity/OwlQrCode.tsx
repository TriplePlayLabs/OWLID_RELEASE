/**
 * OwlQrCode — single styled QR primitive used everywhere in the holder
 * app. Centralises:
 *   - scan-friendly defaults (high error correction so a center logo
 *     doesn't break decoding, generous quiet zone, hard black/white
 *     contrast for cameras at distance + odd angles)
 *   - branded center owl logo
 *   - container chrome (rounded white card, subtle ring) so every QR
 *     looks the same in every modal/screen
 *
 * Why ECC level H: the spec allows ~30% of the modules to be damaged or
 * obscured and still decode. Anything less and the centered owl mark
 * starts producing scan failures on real phones in real lighting.
 */

import { QRCodeSVG } from 'qrcode.react'
import { cn } from '@owlid/ui/lib/utils'

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
      <QRCodeSVG
        value={value}
        size={size}
        // Quiet zone: spec mandates 4 modules; qrcode.react treats
        // marginSize as module units. Keep at 2 because the surrounding
        // white card already provides physical quiet space.
        marginSize={2}
        level="H"
        bgColor="#ffffff"
        fgColor="#0B0D12"
        imageSettings={
          showLogo
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
    </div>
  )
}
