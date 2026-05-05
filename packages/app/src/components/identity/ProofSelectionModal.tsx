import { BadgeCheck, Loader2 } from 'lucide-react'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '~/components/ui/dialog'
import type { DerivedProof } from '~/types/proof'

interface ProofSelectionModalProps {
  isOpen: boolean
  proofs: DerivedProof[]
  selectedProofs: Set<string>
  isGenerating?: boolean
  onClose: () => void
  onToggleProof: (proofId: string) => void
  onCreateProofs: () => void
}

export function ProofSelectionModal({
  isOpen,
  proofs,
  selectedProofs,
  isGenerating = false,
  onClose,
  onToggleProof,
  onCreateProofs,
}: ProofSelectionModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="bg-zinc-950 border-white/10 max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <BadgeCheck className="w-5 h-5" />
            Choose what you want to prove
          </DialogTitle>
          <DialogDescription>
            Select what you want to prove. We only share the result, not your full details.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 mt-4">
          {proofs.map((proof) => {
            const Icon = proof.icon
            const isSelected = selectedProofs.has(proof.id)
            return (
              <label
                key={proof.id}
                className={`flex items-start gap-3 p-4 rounded-lg border transition-all cursor-pointer ${
                  isSelected
                    ? 'border-white/30 bg-white/5'
                    : 'border-white/10 hover:border-white/20 hover:bg-white/[0.02]'
                }`}
                data-testid={`proof-checkbox-${proof.id}`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggleProof(proof.id)}
                  className="mt-1 w-4 h-4 rounded border-white/20 bg-transparent checked:bg-white checked:border-white focus:ring-white/20 focus:ring-offset-0"
                />
                <div className="flex-1 flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-md bg-white/5 shrink-0">
                      <Icon className="w-4 h-4 text-muted-foreground" />
                    </div>
                    <div className="space-y-1">
                      <div className="font-medium text-sm">{proof.title}</div>
                      <div className="text-xs text-muted-foreground">{proof.claim}</div>
                      <p className="text-xs text-muted-foreground/70 leading-relaxed">
                        {proof.description}
                      </p>
                    </div>
                  </div>
                  <div
                    className={`px-2 py-1 rounded text-xs font-mono font-bold shrink-0 ${
                      proof.result
                        ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                        : 'bg-red-500/20 text-red-400 border border-red-500/30'
                    }`}
                  >
                    {proof.result ? 'TRUE' : 'FALSE'}
                  </div>
                </div>
              </label>
            )
          })}
        </div>

        <DialogFooter className="mt-6 gap-2">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isGenerating}
            className="border-white/10 hover:bg-white/5"
          >
            Cancel
          </Button>
          <Button
            onClick={onCreateProofs}
            disabled={selectedProofs.size === 0 || isGenerating}
            className="bg-white text-black hover:bg-white/90"
            data-testid="button-create-proofs"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <BadgeCheck className="w-4 h-4 mr-2" />
                Create {selectedProofs.size > 0 ? `${selectedProofs.size} ` : ''}
                proof{selectedProofs.size !== 1 ? 's' : ''}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
