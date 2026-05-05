import { Copy, Share2, ShieldCheck } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { toast } from 'sonner'
import type { StoredProof } from '@owlid/sdk'
import { Button } from '@owlid/ui/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@owlid/ui/components/ui/dialog'
import { registerModal, type ModalRenderProps } from '@owlid/ui/modal'
import { buildQrPayload, relativeTime } from '~/lib/proof-display'

interface Args {
  proof: StoredProof
}

function ProofQrModal({ isOpen, args, close }: ModalRenderProps<Args>) {
  const { proof } = args

  const handleCopy = async () => {
    await navigator.clipboard.writeText(buildQrPayload(proof))
    toast.success('Proof payload copied')
  }

  const handleShare = async () => {
    const text = buildQrPayload(proof)
    if (navigator.share) {
      try {
        await navigator.share({ title: `OwlID proof: ${proof.claim}`, text })
        return
      } catch {
        /* fall through */
      }
    }
    await navigator.clipboard.writeText(text)
    toast.success('Proof payload copied')
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span
              className={`p-1.5 rounded-full ring-1 ${
                proof.result
                  ? 'bg-green-500/15 text-green-400 ring-green-500/20'
                  : 'bg-red-500/10 text-red-400 ring-red-500/20'
              }`}
            >
              <ShieldCheck className="w-4 h-4" />
            </span>
            {proof.claim}
          </DialogTitle>
          <DialogDescription>
            Show this QR to the verifier. Bound to a one-shot challenge; expires per the issuer's
            TTL.
          </DialogDescription>
        </DialogHeader>
        <div className="bg-white p-4 rounded-xl flex items-center justify-center">
          <QRCodeSVG value={buildQrPayload(proof)} size={240} level="M" />
        </div>
        <p className="text-[11px] text-center text-muted-foreground/70">
          Minted {relativeTime(new Date(proof.createdAt))} ·{' '}
          {new Date(proof.createdAt).toLocaleString()}
        </p>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="secondary" className="flex-1" onClick={handleCopy}>
            <Copy className="w-4 h-4 mr-2" />
            Copy
          </Button>
          <Button variant="secondary" className="flex-1" onClick={handleShare}>
            <Share2 className="w-4 h-4 mr-2" />
            Share
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export const { open: openProofQrModal } = registerModal<Args>(ProofQrModal, {
  key: 'identity:proof-qr',
  defaultArgs: { proof: undefined as unknown as StoredProof },
})
