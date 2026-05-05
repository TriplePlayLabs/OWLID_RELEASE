import { Lock } from 'lucide-react'
import type { GeneratedProof } from '~/types/proof'

interface ProofBadgesProps {
  proofs: GeneratedProof[]
  onViewProof: (proof: GeneratedProof) => void
}

export function ProofBadges({ proofs, onViewProof }: ProofBadgesProps) {
  if (proofs.length === 0) return null

  return (
    <div className="mt-8 w-full max-w-[420px]">
      <div className="flex items-center gap-2 mb-4">
        <div className="h-px bg-white/10 flex-1"></div>
        <span className="text-xs text-muted-foreground uppercase tracking-wider">
          What you can prove
        </span>
        <div className="h-px bg-white/10 flex-1"></div>
      </div>
      <div className="flex flex-wrap gap-3 justify-center">
        {proofs.map((proof) => (
          <button
            key={proof.id}
            onClick={() => onViewProof(proof)}
            aria-label={`View proof: ${proof.name}`}
            className="flex flex-col items-center gap-2 p-3 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/20 transition-all group"
            data-testid={`proof-icon-${proof.id}`}
          >
            <div
              className={`p-2 rounded-full ${
                proof.result ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
              }`}
            >
              <Lock className="w-5 h-5" />
            </div>
            <span className="text-xs text-muted-foreground group-hover:text-white transition-colors max-w-[80px] text-center leading-tight">
              {proof.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
