import type { DerivedProof } from '~/types/proof'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@owlid/ui/components/ui/tooltip'

interface ProofBadgesProps {
  proofs: DerivedProof[]
}

// Compact tag list of every ZK predicate this credential can satisfy.
// A tiny coloured dot signals the predicate's outcome on the holder's
// claims (green = currently satisfied, dim red = wouldn't satisfy).
export function ProofBadges({ proofs }: ProofBadgesProps) {
  if (proofs.length === 0) return null

  return (
    <section className="mt-6 w-full max-w-md">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[10px] font-medium tracking-[0.18em] uppercase text-muted-foreground/70">
          What you can prove
        </span>
        <div className="h-px bg-white/10 flex-1"></div>
      </div>
      <TooltipProvider delayDuration={150}>
        <ul className="flex flex-wrap gap-1.5" data-testid="proof-tags">
          {proofs.map((proof) => (
            <li key={proof.id}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="group inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/[0.07] hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
                    data-testid={`proof-tag-${proof.id}`}
                  >
                    <span
                      aria-hidden
                      className={`h-1.5 w-1.5 rounded-full ${
                        proof.result ? 'bg-green-400' : 'bg-red-400/60'
                      }`}
                    />
                    <span>{proof.claim}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[240px] text-xs">
                  <p className="font-medium mb-0.5">{proof.title}</p>
                  <p className="opacity-70 leading-snug">{proof.description}</p>
                </TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
      </TooltipProvider>
    </section>
  )
}
