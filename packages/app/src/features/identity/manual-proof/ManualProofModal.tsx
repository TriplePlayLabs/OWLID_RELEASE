import { useState, useCallback } from 'react'
import { Camera, Check, ClipboardPaste, Copy, Fingerprint, QrCode, ScanLine, X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { Scanner } from '@yudiel/react-qr-scanner'
import { toast } from 'sonner'
import { Button } from '@owlid/ui/components/ui/button'
import { Checkbox } from '@owlid/ui/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@owlid/ui/components/ui/dialog'
import { Spinner } from '@owlid/ui/components/ui/spinner'
import { Textarea } from '@owlid/ui/components/ui/textarea'
import { registerModal, toRadixDialogProps, type ModalRenderProps } from '@owlid/ui/modal'
import { useProofs } from '~/hooks/use-proofs'

function ManualProofModal(props: ModalRenderProps<Record<string, never>>) {
  const { close } = props
  const {
    availableProofs,
    selectedProofs,
    generatedProofs,
    isGenerating,
    toggleProofSelection,
    createProofs,
    resetProofs,
  } = useProofs()

  const [challenge, setChallenge] = useState('')
  const [step, setStep] = useState<'enter' | 'scan' | 'review' | 'show'>('enter')
  const [scanError, setScanError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const copyToken = useCallback(async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedId(id)
      toast.success('Token copied')
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500)
    } catch {
      toast.error('Copy failed — long-press the text to copy manually')
    }
  }, [])

  const proofsForCurrentChallenge = generatedProofs.filter((p) => p.qrData && p.qrData.length > 0)

  const handleNext = () => {
    if (challenge.trim()) setStep('review')
  }

  const handleGenerate = async () => {
    if (!challenge.trim() || selectedProofs.size === 0) return
    await createProofs(challenge.trim())
    setStep('show')
  }

  return (
    <Dialog {...toRadixDialogProps(props)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sign a verifier challenge</DialogTitle>
          <DialogDescription>
            {step === 'enter' && 'Paste the challenge the verifier showed you.'}
            {step === 'scan' && 'Point your camera at the verifier challenge QR.'}
            {step === 'review' &&
              'Pick which claims to prove. The proof is signed offline; show the resulting QR to any verifier.'}
            {step === 'show' && 'Show this QR / token to the verifier.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'enter' && (
          <div className="space-y-3">
            <Textarea
              value={challenge}
              onChange={(e) => setChallenge(e.target.value)}
              placeholder="Paste the verifier's challenge (hex)"
              className="h-24 font-mono text-sm"
              data-testid="input-manual-challenge"
            />
            <Button
              variant="outline"
              onClick={() => {
                setScanError(null)
                setStep('scan')
              }}
              className="w-full"
              data-testid="button-scan-challenge"
            >
              <ScanLine className="w-4 h-4 mr-2" />
              Scan challenge QR instead
            </Button>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="ghost" className="flex-1" onClick={close}>
                Cancel
              </Button>
              <Button className="flex-1" onClick={handleNext} disabled={!challenge.trim()}>
                Next
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'scan' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-medium flex items-center gap-2 text-sm">
                <Camera className="w-4 h-4 text-blue-400" />
                Scan verifier challenge QR
              </h3>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setStep('enter')}
                aria-label="Cancel scanning"
                className="h-8 w-8"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
            <div className="rounded-xl overflow-hidden border border-white/10 bg-black">
              <Scanner
                onScan={(result) => {
                  const value = result?.[0]?.rawValue
                  if (!value) return
                  setChallenge(value.trim())
                  setStep('review')
                }}
                onError={(err) =>
                  setScanError(err instanceof Error ? err.message : 'Camera unavailable')
                }
                styles={{
                  container: { width: '100%', aspectRatio: '1' },
                  video: { objectFit: 'cover' },
                }}
                components={{ torch: true, finder: true }}
              />
            </div>
            {scanError && (
              <p className="text-xs text-red-400">
                {scanError}. Make sure camera permission is granted, or paste the challenge instead.
              </p>
            )}
          </div>
        )}

        {step === 'review' && (
          <div className="space-y-3">
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {availableProofs.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No claims available. Complete identity verification first.
                </p>
              )}
              {availableProofs.map((p) => {
                const checked = selectedProofs.has(p.id)
                return (
                  <label
                    key={p.id}
                    className="flex items-start gap-3 p-3 rounded-lg border border-white/10 cursor-pointer hover:bg-white/5 transition-colors"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggleProofSelection(p.id)}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <div className="text-sm font-medium">{p.title}</div>
                      <div className="text-xs text-muted-foreground">{p.description}</div>
                    </div>
                  </label>
                )
              })}
            </div>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setStep('enter')}>
                Back
              </Button>
              <Button
                className="flex-1"
                onClick={handleGenerate}
                disabled={isGenerating || selectedProofs.size === 0}
                data-testid="button-manual-generate"
              >
                {isGenerating ? (
                  <>
                    <Spinner className="w-4 h-4 mr-2" />
                    Generating…
                  </>
                ) : (
                  <>
                    <Fingerprint className="w-4 h-4 mr-2" />
                    Generate proof
                  </>
                )}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'show' && (
          <div className="space-y-4">
            {proofsForCurrentChallenge.length === 0 && (
              <p className="text-sm text-muted-foreground">No proofs generated.</p>
            )}
            {proofsForCurrentChallenge.map((proof) => {
              const isCopied = copiedId === proof.id
              return (
                <div
                  key={proof.id}
                  className="space-y-3 p-3 rounded-lg border border-white/10 bg-card/30"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium">{proof.claim}</div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => copyToken(proof.id, proof.qrData)}
                      className="h-8 px-3 text-xs"
                      data-testid={`button-copy-token-${proof.id}`}
                    >
                      {isCopied ? (
                        <>
                          <Check className="w-3.5 h-3.5 mr-1.5" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5 mr-1.5" />
                          Copy
                        </>
                      )}
                    </Button>
                  </div>
                  <div className="bg-white p-3 rounded-md flex justify-center">
                    <QRCodeSVG value={proof.qrData} size={220} />
                  </div>
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Show as text</summary>
                    <div className="mt-2 font-mono break-all select-all">{proof.qrData}</div>
                  </details>
                </div>
              )
            })}
            <DialogFooter className="gap-2 sm:gap-2">
              <Button
                variant="ghost"
                className="flex-1"
                onClick={() => {
                  resetProofs()
                  setChallenge('')
                  setStep('enter')
                }}
              >
                <QrCode className="w-4 h-4 mr-2" />
                New challenge
              </Button>
              <Button className="flex-1" onClick={close}>
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export const { open: openManualProofModal } = registerModal<Record<string, never>>(
  ManualProofModal,
  { key: 'identity:manual-proof', defaultArgs: {} },
)

export function ManualProofTrigger() {
  return (
    <Button
      variant="outline"
      onClick={() => openManualProofModal({})}
      className="w-full h-11 text-sm font-medium"
      data-testid="button-manual-proof"
    >
      <ClipboardPaste className="w-4 h-4 mr-2" />
      Manual
    </Button>
  )
}
