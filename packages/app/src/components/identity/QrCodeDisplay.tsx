/**
 * QR Code Display Component
 *
 * Displays a QR code for BankID-style polling flows.
 * Shows status updates while the user scans with their mobile app.
 */

import { useEffect } from 'react'
import { Loader2, CheckCircle, XCircle, Smartphone, RefreshCw } from 'lucide-react'
import type { SessionStatus } from '@owlid/sdk/issuer'
import { OwlQrCode } from '~/components/identity/OwlQrCode'

interface QrCodeDisplayProps {
  /** QR code data to display */
  qrData: string
  /** Current verification status */
  status:
    | SessionStatus
    | 'idle'
    | 'starting'
    | 'pending'
    | 'verifying'
    | 'verified'
    | 'failed'
    | 'expired'
  /** Status message from polling */
  message?: string | null
  /** Hint for user (e.g., "Open your BankID app") */
  hint?: string | null
  /** Whether polling is active */
  isPolling?: boolean
  /** Callback when polling should start */
  onStartPolling?: () => void
  /** Callback when polling should stop */
  onStopPolling?: () => void
  /** Optional auto-start URL for mobile deep link */
  autoStartUrl?: string | null
  /** Size of the QR code in pixels */
  size?: number
}

export function QrCodeDisplay({
  qrData,
  status,
  message,
  hint,
  isPolling,
  onStartPolling,
  onStopPolling,
  autoStartUrl,
  size = 200,
}: QrCodeDisplayProps) {
  // Start polling when component mounts
  useEffect(() => {
    if (status === 'pending' && onStartPolling && !isPolling) {
      onStartPolling()
    }

    return () => {
      if (onStopPolling) {
        onStopPolling()
      }
    }
  }, [status, onStartPolling, onStopPolling, isPolling])

  const getStatusIcon = () => {
    switch (status) {
      case 'verified':
        return <CheckCircle className="h-16 w-16 text-green-500" />
      case 'failed':
        return <XCircle className="h-16 w-16 text-red-500" />
      case 'expired':
        return <RefreshCw className="h-16 w-16 text-amber-500" />
      case 'verifying':
        return <Loader2 className="h-16 w-16 text-blue-500 animate-spin" />
      default:
        return null
    }
  }

  const getStatusText = () => {
    switch (status) {
      case 'pending':
        return 'Scan the QR code with your mobile app'
      case 'verifying':
        return message || 'Verifying your identity...'
      case 'verified':
        return 'Verification successful!'
      case 'failed':
        return message || 'Verification failed'
      case 'expired':
        return 'Session expired. Please start again.'
      default:
        return ''
    }
  }

  const showQrCode = status === 'pending' || status === 'idle' || status === 'starting'
  const showOverlay =
    status === 'verifying' || status === 'verified' || status === 'failed' || status === 'expired'

  return (
    <div className="flex flex-col items-center space-y-4">
      {/* QR Code Container */}
      <div className="relative">
        <div
          className={`transition-opacity duration-200 ${
            showOverlay ? 'opacity-30' : 'opacity-100'
          }`}
        >
          <OwlQrCode value={qrData} size={size} ariaLabel="Session QR" />
        </div>

        {/* Status Overlay */}
        {showOverlay && (
          <div className="absolute inset-0 flex items-center justify-center">{getStatusIcon()}</div>
        )}
      </div>

      {/* Status Text */}
      <div className="text-center space-y-2">
        <p
          className={`text-sm font-medium ${
            status === 'verified'
              ? 'text-green-600'
              : status === 'failed' || status === 'expired'
                ? 'text-red-600'
                : 'text-gray-600'
          }`}
        >
          {getStatusText()}
        </p>

        {/* Hint */}
        {hint && status !== 'verified' && status !== 'failed' && (
          <p className="text-xs text-gray-500 flex items-center justify-center gap-1">
            <Smartphone className="h-3 w-3" />
            {hint}
          </p>
        )}

        {/* Polling indicator */}
        {isPolling && status === 'pending' && (
          <p className="text-xs text-gray-400 flex items-center justify-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Waiting for response...
          </p>
        )}
      </div>

      {/* Mobile deep link button */}
      {autoStartUrl && showQrCode && (
        <a
          href={autoStartUrl}
          className="mt-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors flex items-center gap-2"
        >
          <Smartphone className="h-4 w-4" />
          Open on this device
        </a>
      )}
    </div>
  )
}
