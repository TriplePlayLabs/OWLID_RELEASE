import { useEffect } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { AlertTriangle, CheckCircle2, QrCode, RefreshCw, Send, ShieldOff } from 'lucide-react'
import { Button } from '@owlid/ui/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@owlid/ui/components/ui/dialog'
import { Skeleton } from '@owlid/ui/components/ui/skeleton'
import { Spinner } from '@owlid/ui/components/ui/spinner'

const QR_SIZE = 220
import { registerModal, toRadixDialogProps, type ModalRenderProps } from '@owlid/ui/modal'
import { ConsentScreen } from '~/components/identity/ConsentScreen'
import { usePresentation } from '~/hooks/use-presentation'

/**
 * Map an attribute name to a generic, value-free message. The verifier asked
 * about this field, so naming it back is fine; the value MUST never appear.
 */
function unmetAttributeMessage(attribute: string | null): string {
  switch (attribute) {
    case 'dateOfBirth':
      return "You don't meet the age requirement for this verification."
    case 'nationality':
      return "Your nationality isn't accepted for this verification."
    case 'verificationLevel':
      return 'Your KYC level is below what this verifier requires.'
    case 'isResident':
      return "You aren't a verified resident for this verifier."
    default:
      return "You don't meet the requirements for this verification."
  }
}

function PresentationModal(props: ModalRenderProps<Record<string, never>>) {
  const { isOpen, close } = props
  const {
    state,
    sessionQr,
    request,
    predicateChecks,
    error,
    unmetAttribute,
    startPresentation,
    approve,
    deny,
    cancel,
  } = usePresentation()

  // Kick off the flow as soon as the modal mounts, but only once per open.
  useEffect(() => {
    if (isOpen && state === 'idle') startPresentation()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const handleClose = () => {
    cancel()
    close()
  }

  return (
    <Dialog {...toRadixDialogProps({ ...props, close: handleClose })}>
      <DialogContent className="sm:max-w-sm">
        {state === 'idle' ||
        state === 'creating' ||
        state === 'showing_qr' ||
        state === 'waiting' ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className="p-1.5 rounded-full bg-blue-500/15 text-blue-400 ring-1 ring-blue-500/20">
                  <QrCode className="w-4 h-4" />
                </span>
                Present your ID
              </DialogTitle>
              <DialogDescription>
                {sessionQr ? 'Show this QR code to the verifier.' : 'Setting up secure session…'}
              </DialogDescription>
            </DialogHeader>
            <div
              className="bg-white p-4 rounded-xl flex items-center justify-center"
              style={{ minHeight: QR_SIZE + 32 }}
            >
              {sessionQr ? (
                <QRCodeSVG value={sessionQr} size={QR_SIZE} level="M" />
              ) : (
                <Skeleton
                  className="rounded-md bg-zinc-200/60"
                  style={{ width: QR_SIZE, height: QR_SIZE }}
                />
              )}
            </div>
            <div className="flex items-center justify-center gap-2 text-muted-foreground min-h-[1.25rem]">
              <Spinner className="w-3.5 h-3.5" />
              <span className="text-xs">
                {sessionQr ? 'Waiting for verifier to scan…' : 'Creating session…'}
              </span>
            </div>
            <DialogFooter>
              <Button variant="outline" className="w-full" onClick={handleClose}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        ) : state === 'consent' && request ? (
          <ConsentScreen
            request={request}
            predicateChecks={predicateChecks}
            isGenerating={false}
            onApprove={approve}
            onDeny={deny}
          />
        ) : state === 'generating' ? (
          <>
            <DialogHeader>
              <DialogTitle>Creating proof</DialogTitle>
              <DialogDescription>Generating zero-knowledge proof…</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3 py-6">
              <span className="w-14 h-14 rounded-full bg-blue-500/15 text-blue-400 ring-1 ring-blue-500/20 flex items-center justify-center">
                <Spinner className="w-6 h-6" />
              </span>
            </div>
          </>
        ) : state === 'sending' ? (
          <>
            <DialogHeader>
              <DialogTitle>Sending proof</DialogTitle>
              <DialogDescription>Transmitting to verifier…</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3 py-6">
              <span className="w-14 h-14 rounded-full bg-blue-500/15 text-blue-400 ring-1 ring-blue-500/20 flex items-center justify-center">
                <Send className="w-6 h-6 animate-pulse" />
              </span>
            </div>
          </>
        ) : state === 'not_satisfied' ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className="p-1.5 rounded-full bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/20">
                  <ShieldOff className="w-4 h-4" />
                </span>
                Verification failed
              </DialogTitle>
              <DialogDescription>{unmetAttributeMessage(unmetAttribute)}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button className="w-full" onClick={handleClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : state === 'complete' ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className="p-1.5 rounded-full bg-green-500/15 text-green-400 ring-1 ring-green-500/20">
                  <CheckCircle2 className="w-4 h-4" />
                </span>
                Verified
              </DialogTitle>
              <DialogDescription>Proof sent successfully.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button className="w-full" onClick={handleClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : state === 'error' ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className="p-1.5 rounded-full bg-red-500/10 text-red-400 ring-1 ring-red-500/20">
                  <AlertTriangle className="w-4 h-4" />
                </span>
                Something went wrong
              </DialogTitle>
              {error && <DialogDescription>{error}</DialogDescription>}
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="outline" className="flex-1" onClick={handleClose}>
                Close
              </Button>
              <Button className="flex-1" onClick={startPresentation}>
                <RefreshCw className="w-4 h-4 mr-2" />
                Retry
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

export const { open: openPresentationModal } = registerModal<Record<string, never>>(
  PresentationModal,
  { key: 'identity:presentation', defaultArgs: {} },
)
