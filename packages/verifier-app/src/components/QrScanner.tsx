import { useState } from 'react'
import { Scanner } from '@yudiel/react-qr-scanner'
import { Camera, X, AlertCircle } from 'lucide-react'

interface QrScannerProps {
  onScan: (data: string) => void
  onCancel: () => void
}

export function QrScanner({ onScan, onCancel }: QrScannerProps) {
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium flex items-center gap-2">
          <Camera className="w-5 h-5 text-blue-400" />
          Scan QR Code
        </h3>
        <button
          onClick={onCancel}
          className="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors"
          aria-label="Cancel scanning"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="rounded-xl overflow-hidden border border-white/10 bg-black">
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
        Point your camera at an OwlID proof QR code
      </p>
    </div>
  )
}
