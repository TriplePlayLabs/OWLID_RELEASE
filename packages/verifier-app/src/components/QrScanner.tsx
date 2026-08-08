import { useState, lazy, Suspense } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'

// The scanner ships a ~1 MB zxing WASM decoder — load it only when a
// scan actually starts, not on app startup.
const Scanner = lazy(() => import('@yudiel/react-qr-scanner').then((m) => ({ default: m.Scanner })))

interface QrScannerProps {
  onScan: (data: string) => void
  onCancel: () => void
  /** Optional caption rendered under the camera view. Defaults to the
   *  generic OwlID proof QR prompt. */
  caption?: string
}

/** Headless scanner card — the parent owns the title + close button so
 *  there's only one heading on screen. Renders the camera preview, a
 *  permission error, and a short caption. */
export function QrScanner({ onScan, onCancel: _onCancel, caption }: QrScannerProps) {
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="space-y-4">
      <div className="rounded-xl overflow-hidden border border-white/10 bg-black">
        <Suspense
          fallback={
            <div className="w-full aspect-square flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
            </div>
          }
        >
          <Scanner
            onScan={(result) => {
              if (result?.[0]?.rawValue) {
                onScan(result[0].rawValue)
              }
            }}
            onError={(err) => {
              if (err instanceof Error) {
                setError(err.message)
              } else {
                setError('Camera access denied or not available')
              }
            }}
            styles={{
              container: { width: '100%', aspectRatio: '1' },
              video: { objectFit: 'cover' },
            }}
            components={{
              torch: true,
              finder: true,
            }}
          />
        </Suspense>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <p>{error}</p>
            <p className="text-xs text-red-400/70 mt-1">
              Make sure you've granted camera permission to this site.
            </p>
          </div>
        </div>
      )}

      <p className="text-xs text-center text-zinc-500">
        {caption ?? 'Point your camera at an Owl ID proof QR code'}
      </p>
    </div>
  )
}
