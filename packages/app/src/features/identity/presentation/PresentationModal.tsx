import { useEffect } from 'react'
import { AlertTriangle, CheckCircle2, QrCode, RefreshCw, XCircle } from 'lucide-react'
import { OwlQrCode } from '~/components/identity/OwlQrCode'
import { formatPresentationError } from '~/lib/presentation-errors'
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

const QR_SIZE = 280
import { registerModal, type ModalRenderProps } from '@owlid/ui/modal'
import { ConsentScreen } from '~/components/identity/ConsentScreen'
import { ProvingSteps } from '~/components/identity/ProvingSteps'
import { usePresentation } from '~/hooks/use-presentation'

function PresentationModal(props: ModalRenderProps<Record<string, never>>) {
  const { isOpen, close } = props
  const {
    state,
    sessionQr,
    request,
    matchSummary,
    overrides,
    setOverride,
    attestProgress,
    error,
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

  // States during which the modal MUST NOT close on accidental
  // click-outside / Escape — the user is actively presenting their ID
  // and an accidental dismiss either drops their consent decision
  // mid-decryption (`consent`), throws away the in-flight proof
  // (`generating`, `sending`), or aborts a session the verifier is
  // already connected to (`waiting`). Terminal states (`complete`,
  // `denied`, `error`) are dismissable normally.
  const locked =
    state === 'consent' ||
    state === 'generating' ||
    state === 'sending' ||
    state === 'waiting' ||
    state === 'showing_qr' ||
    state === 'creating'
  const guardDismiss = (e: Event) => {
    if (locked) e.preventDefault()
  }
  const handleOpenChange = (open: boolean) => {
    if (open) return
    if (locked) return // ignore programmatic close attempts while locked
    handleClose()
  }

  return (
    <Dialog open={isOpen} modal onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-sm"
        showCloseButton={!locked}
        onPointerDownOutside={guardDismiss}
        onInteractOutside={guardDismiss}
        onEscapeKeyDown={guardDismiss}
      >
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
            <div className="flex items-center justify-center" style={{ minHeight: QR_SIZE + 40 }}>
              {sessionQr ? (
                <OwlQrCode value={sessionQr} size={QR_SIZE} ariaLabel="Presentation session QR" />
              ) : (
                <Skeleton
                  className="rounded-2xl bg-zinc-200/60"
                  style={{ width: QR_SIZE + 40, height: QR_SIZE + 40 }}
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
            matchSummary={matchSummary}
            overrides={overrides}
            onSelectCredential={setOverride}
            isGenerating={false}
            onApprove={approve}
            onDeny={deny}
          />
        ) : state === 'generating' || state === 'sending' ? (
          <>
            <DialogHeader>
              <DialogTitle>Building your proof</DialogTitle>
              <DialogDescription>
                Each predicate the verifier asked for is proven on your device. First time takes
                ~20–30s on Midnight; subsequent presentations are instant.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4 max-h-[60vh] overflow-y-auto">
              <ProvingSteps progress={attestProgress} sending={state === 'sending'} />
            </div>
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
        ) : state === 'denied' ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className="p-1.5 rounded-full bg-zinc-500/15 text-zinc-400 ring-1 ring-zinc-500/20">
                  <XCircle className="w-4 h-4" />
                </span>
                Request denied
              </DialogTitle>
              <DialogDescription>
                Nothing was sent to the verifier. They&apos;ll see a denial — no claim values or
                credentials crossed your device.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button className="w-full" onClick={handleClose}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : state === 'error' ? (
          (() => {
            const friendly = formatPresentationError(error ?? new Error('Unknown error'))
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <span className="p-1.5 rounded-full bg-red-500/10 text-red-400 ring-1 ring-red-500/20">
                      <AlertTriangle className="w-4 h-4" />
                    </span>
                    {friendly.title}
                  </DialogTitle>
                  <DialogDescription>{friendly.body}</DialogDescription>
                </DialogHeader>
                {friendly.hint && (
                  <p className="text-xs text-amber-200/90 leading-relaxed -mt-2">{friendly.hint}</p>
                )}
                <div className="py-2 max-h-[40vh] overflow-y-auto">
                  <ProvingSteps progress={attestProgress} errored errorMessage={friendly.body} />
                </div>
                <details className="text-[11px] text-muted-foreground/70 -mt-1">
                  <summary className="cursor-pointer select-none">Technical details</summary>
                  <p className="mt-1 font-mono break-words leading-snug">{friendly.raw}</p>
                </details>
                <DialogFooter className="gap-2 sm:gap-2">
                  <Button variant="outline" className="flex-1" onClick={handleClose}>
                    Close
                  </Button>
                  {friendly.retryable && (
                    <Button className="flex-1" onClick={startPresentation}>
                      <RefreshCw className="w-4 h-4 mr-2" />
                      Try again
                    </Button>
                  )}
                </DialogFooter>
              </>
            )
          })()
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

export const { open: openPresentationModal } = registerModal<Record<string, never>>(
  PresentationModal,
  { key: 'identity:presentation', defaultArgs: {} },
)
