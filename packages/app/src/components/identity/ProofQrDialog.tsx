import { Copy, Share2, ShieldCheck, X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import type { StoredProof } from '@owlid/sdk'
import { Button } from '@owlid/ui/components/ui/button'
import { buildQrPayload, relativeTime } from '~/lib/proof-display'
import { cn } from '@owlid/ui/lib/utils'

interface ProofQrDialogProps {
  proof: StoredProof | null
  onClose: () => void
  onCopy: (p: StoredProof) => void
  onShare: (p: StoredProof) => void
}

// Custom dialog primitive instead of `@owlid/ui/components/ui/dialog` so we can
// override the default top-slide animation with a calmer fade+scale and
// drop the inline close button (we render our own).
export function ProofQrDialog({ proof, onClose, onCopy, onShare }: ProofQrDialogProps) {
  return (
    <DialogPrimitive.Root open={!!proof} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-black/70 backdrop-blur-sm',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
            'duration-200',
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
            'w-[calc(100%-2rem)] sm:w-auto sm:max-w-sm',
            'rounded-2xl border border-white/10 bg-zinc-950/95 p-0 shadow-2xl shadow-black/50',
            'origin-center',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
            'data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95',
            'duration-200 ease-out',
          )}
          aria-describedby={undefined}
        >
          {proof && (
            <div className="flex flex-col">
              {/* Header */}
              <div className="relative flex items-center gap-3 px-5 pt-5 pb-3">
                <span
                  className={cn(
                    'shrink-0 w-9 h-9 rounded-full flex items-center justify-center',
                    proof.result
                      ? 'bg-green-500/15 text-green-400 ring-1 ring-green-500/20'
                      : 'bg-red-500/10 text-red-400 ring-1 ring-red-500/20',
                  )}
                >
                  <ShieldCheck className="w-4 h-4" />
                </span>
                <div className="flex-1 min-w-0">
                  <DialogPrimitive.Title className="text-base font-semibold leading-tight truncate">
                    {proof.claim}
                  </DialogPrimitive.Title>
                  <p className="text-[11px] text-muted-foreground/80 mt-0.5">
                    Minted {relativeTime(new Date(proof.createdAt))} ·{' '}
                    {new Date(proof.createdAt).toLocaleString()}
                  </p>
                </div>
                <DialogPrimitive.Close
                  className="shrink-0 -mr-1 -mt-1 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </DialogPrimitive.Close>
              </div>

              {/* QR canvas */}
              <div className="px-5 pb-3">
                <div className="relative rounded-xl bg-white p-5 flex items-center justify-center">
                  <QRCodeSVG
                    value={buildQrPayload(proof)}
                    size={240}
                    level="M"
                    includeMargin={false}
                  />
                </div>
                <p className="mt-3 text-[11px] text-center text-muted-foreground/70 leading-relaxed">
                  Show this QR to the verifier. Bound to a one-shot challenge; expires per the
                  issuer's TTL.
                </p>
              </div>

              {/* Actions */}
              <div className="flex gap-2 px-5 pb-5 pt-1">
                <Button variant="secondary" className="flex-1 h-10" onClick={() => onCopy(proof)}>
                  <Copy className="w-4 h-4 mr-2" />
                  Copy
                </Button>
                <Button variant="secondary" className="flex-1 h-10" onClick={() => onShare(proof)}>
                  <Share2 className="w-4 h-4 mr-2" />
                  Share
                </Button>
              </div>
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
