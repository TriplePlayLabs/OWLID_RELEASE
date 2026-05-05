import { useState, useEffect, useMemo } from 'react'
import { Lock, Copy, Check, Share2, FileText } from 'lucide-react'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '~/components/ui/dialog'
import { QRCodeSVG } from 'qrcode.react'
import type { GeneratedProof } from '~/types/proof'

// QR code v40 capacity: Level L = 4,296 alphanumeric, Level M = 3,391
// Base45 (used by compact tokens) is alphanumeric-compatible
// Use 3,000 as safe limit for Level M; fall back to Level L for larger tokens
const QR_MAX_SIZE_M = 3000
const QR_MAX_SIZE_L = 4200

interface ProofQRModalProps {
  proof: GeneratedProof | null
  onClose: () => void
  onShare: (proof: GeneratedProof) => Promise<boolean>
}

export function ProofQRModal({ proof, onClose, onShare }: ProofQRModalProps) {
  const [copied, setCopied] = useState(false)
  const [hasNativeShare, setHasNativeShare] = useState(false)

  // Determine QR error correction level based on data size
  const qrState = useMemo(() => {
    if (!proof?.qrData) return { tooLarge: false, level: 'M' as const }
    const len = proof.qrData.length
    if (len <= QR_MAX_SIZE_M) return { tooLarge: false, level: 'M' as const }
    if (len <= QR_MAX_SIZE_L) return { tooLarge: false, level: 'L' as const }
    return { tooLarge: true, level: 'L' as const }
  }, [proof?.qrData])

  const isQrTooLarge = qrState.tooLarge

  useEffect(() => {
    // Only show share on mobile - desktop share dialogs are buggy
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    setHasNativeShare(isMobile && !!navigator.share)
  }, [])

  if (!proof) return null

  const handleShare = async () => {
    const success = await onShare(proof)
    if (success) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <Dialog open={!!proof} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="bg-zinc-950 border-white/10 max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className={`w-5 h-5 ${proof.result ? 'text-green-400' : 'text-red-400'}`} />
            {proof.name}
          </DialogTitle>
          <DialogDescription>
            <span
              className={`font-mono font-bold ${proof.result ? 'text-green-400' : 'text-red-400'}`}
            >
              {proof.result ? 'VERIFIED: TRUE' : 'VERIFIED: FALSE'}
            </span>
          </DialogDescription>
        </DialogHeader>

        {isQrTooLarge ? (
          <div className="flex flex-col items-center justify-center p-6 bg-zinc-900 rounded-lg my-4 text-center">
            <FileText className="w-12 h-12 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">Proof token is too large for QR code</p>
            <p className="text-xs text-muted-foreground mt-1">Use the copy button to share</p>
          </div>
        ) : (
          <div className="flex justify-center p-6 bg-white rounded-lg my-4">
            <QRCodeSVG
              value={proof.qrData}
              size={200}
              level={qrState.level}
              includeMargin={false}
            />
          </div>
        )}

        <p className="text-xs text-center text-muted-foreground mb-4">
          {isQrTooLarge
            ? 'Copy the proof token to share it with verifiers'
            : 'Anyone can scan this QR code to verify this proof'}
        </p>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={handleShare}
            className="flex-1 border-white/10 hover:bg-white/5"
          >
            {copied ? (
              <>
                <Check className="w-4 h-4 mr-2 text-green-400" />
                Copied!
              </>
            ) : hasNativeShare ? (
              <>
                <Share2 className="w-4 h-4 mr-2" />
                Share
              </>
            ) : (
              <>
                <Copy className="w-4 h-4 mr-2" />
                Copy
              </>
            )}
          </Button>
          <Button onClick={onClose} className="flex-1 bg-white text-black hover:bg-white/90">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
