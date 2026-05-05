/**
 * Presentation Flow
 *
 * "Present ID" button + modal for the full presentation flow.
 * Button lives on the passport page. Modal handles QR, consent, and result states.
 */

import { QRCodeSVG } from 'qrcode.react'
import { Fingerprint, QrCode, CheckCircle2, AlertTriangle, RefreshCw, Send } from 'lucide-react'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '~/components/ui/dialog'
import { Spinner } from '~/components/ui/spinner'
import { ConsentScreen } from '~/components/identity/ConsentScreen'
import { usePresentation } from '~/hooks/use-presentation'

export function PresentationFlow() {
  const { state, sessionQr, request, error, startPresentation, approve, deny, cancel } =
    usePresentation()

  const isOpen = state !== 'idle'

  const handleClose = () => {
    if (
      state === 'complete' ||
      state === 'error' ||
      state === 'showing_qr' ||
      state === 'waiting'
    ) {
      cancel()
    }
  }

  return (
    <>
      {/* Button on passport page */}
      <Button
        onClick={startPresentation}
        disabled={isOpen}
        className="mt-8 bg-white text-black hover:bg-white/90 transition-all h-12 text-base font-medium px-8"
        data-testid="button-present-id"
      >
        <Fingerprint className="w-5 h-5 mr-2" />
        Present ID
      </Button>

      {/* Modal for the entire flow */}
      <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
        <DialogContent className="bg-zinc-950 border-white/10 max-w-sm">
          {/* Creating session */}
          {state === 'creating' && (
            <>
              <DialogHeader>
                <DialogTitle>Present ID</DialogTitle>
                <DialogDescription>Setting up secure session...</DialogDescription>
              </DialogHeader>
              <div className="flex flex-col items-center gap-4 py-8">
                <Spinner className="w-8 h-8 text-white" />
                <p className="text-sm text-zinc-400">Creating session...</p>
              </div>
            </>
          )}

          {/* QR code / Waiting for verifier */}
          {(state === 'showing_qr' || state === 'waiting') && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <QrCode className="w-5 h-5 text-blue-400" />
                  Present your ID
                </DialogTitle>
                <DialogDescription>Show this QR code to the verifier</DialogDescription>
              </DialogHeader>

              {sessionQr && (
                <div className="flex justify-center p-4 bg-white rounded-xl my-4">
                  <QRCodeSVG value={sessionQr} size={220} level="M" includeMargin={false} />
                </div>
              )}

              <div className="flex items-center justify-center gap-2 text-zinc-500 mb-4">
                <Spinner className="w-4 h-4" />
                <span className="text-sm">Waiting for verifier to scan...</span>
              </div>

              <Button
                variant="outline"
                onClick={cancel}
                className="w-full border-white/10 text-zinc-400 hover:text-white"
              >
                Cancel
              </Button>
            </>
          )}

          {/* Consent screen */}
          {state === 'consent' && request && (
            <ConsentScreen
              request={request}
              isGenerating={false}
              onApprove={approve}
              onDeny={deny}
            />
          )}

          {/* Generating proof */}
          {state === 'generating' && (
            <>
              <DialogHeader>
                <DialogTitle>Creating Proof</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col items-center gap-4 py-8">
                <div className="w-16 h-16 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                  <Spinner className="w-8 h-8 text-blue-400" />
                </div>
                <p className="text-sm text-zinc-400 text-center">
                  Generating zero-knowledge proof...
                </p>
              </div>
            </>
          )}

          {/* Sending */}
          {state === 'sending' && (
            <>
              <DialogHeader>
                <DialogTitle>Sending Proof</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col items-center gap-4 py-8">
                <div className="w-16 h-16 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                  <Send className="w-7 h-7 text-blue-400 animate-pulse" />
                </div>
                <p className="text-sm text-zinc-400">Transmitting to verifier...</p>
              </div>
            </>
          )}

          {/* Complete */}
          {state === 'complete' && (
            <>
              <DialogHeader>
                <DialogTitle>Verified</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col items-center gap-4 py-8">
                <div className="w-16 h-16 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                  <CheckCircle2 className="w-8 h-8 text-emerald-400" />
                </div>
                <p className="text-sm text-zinc-400">Proof sent successfully</p>
              </div>
              <Button onClick={cancel} className="w-full bg-white text-black hover:bg-white/90">
                Done
              </Button>
            </>
          )}

          {/* Error */}
          {state === 'error' && (
            <>
              <DialogHeader>
                <DialogTitle>Something went wrong</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col items-center gap-4 py-6">
                <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center">
                  <AlertTriangle className="w-8 h-8 text-red-400" />
                </div>
                {error && <p className="text-sm text-red-400 text-center">{error}</p>}
              </div>
              <div className="flex gap-3">
                <Button variant="outline" onClick={cancel} className="flex-1 border-white/10">
                  Close
                </Button>
                <Button
                  onClick={startPresentation}
                  className="flex-1 bg-white text-black hover:bg-white/90"
                >
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Retry
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
