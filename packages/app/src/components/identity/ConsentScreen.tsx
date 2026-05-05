/**
 * Consent Screen
 *
 * Shows what the verifier is requesting and lets the holder approve or deny.
 * Displayed after the verifier sends a PresentationRequest over the back-channel.
 */

import { Shield, Check, X, Fingerprint } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import type { PresentationRequest } from '@owlid/sdk'

interface ConsentScreenProps {
  request: PresentationRequest
  isGenerating: boolean
  onApprove: () => void
  onDeny: () => void
}

export function ConsentScreen({ request, isGenerating, onApprove, onDeny }: ConsentScreenProps) {
  return (
    <div className="flex flex-col items-center gap-6 w-full max-w-sm mx-auto">
      {/* Verifier identity */}
      <div className="flex flex-col items-center gap-2">
        <div className="w-14 h-14 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
          <Shield className="w-7 h-7 text-blue-400" />
        </div>
        <h3 className="text-lg font-semibold text-white">{request.verifierName}</h3>
        <p className="text-sm text-zinc-400 text-center">wants to verify the following</p>
      </div>

      {/* Requested predicates */}
      <div className="w-full rounded-xl border border-white/10 bg-zinc-900/50 divide-y divide-white/5">
        {request.requestedPredicates.map((predicate) => (
          <div key={predicate.id} className="flex items-center gap-3 px-4 py-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
              <Check className="w-4 h-4 text-emerald-400" />
            </div>
            <span className="text-sm text-zinc-200">{predicate.label}</span>
          </div>
        ))}
        {request.requestedDisclosures.length > 0 && (
          <div className="px-4 py-3">
            <p className="text-xs text-amber-400 mb-1">Disclosed attributes:</p>
            {request.requestedDisclosures.map((attr) => (
              <span
                key={attr}
                className="inline-block text-xs bg-amber-500/10 text-amber-300 rounded px-2 py-0.5 mr-1 mb-1"
              >
                {attr}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Info text */}
      <p className="text-xs text-zinc-500 text-center leading-relaxed">
        Only zero-knowledge proofs are shared. Your personal data never leaves your device.
      </p>

      {/* Action buttons */}
      <div className="flex gap-3 w-full">
        <Button
          variant="outline"
          onClick={onDeny}
          disabled={isGenerating}
          className="flex-1 border-white/10 text-zinc-300 hover:text-white hover:border-white/20"
        >
          <X className="w-4 h-4 mr-2" />
          Deny
        </Button>
        <Button
          onClick={onApprove}
          disabled={isGenerating}
          className="flex-1 bg-white text-black hover:bg-white/90"
        >
          {isGenerating ? (
            <>
              <Spinner className="w-4 h-4 mr-2" />
              Generating...
            </>
          ) : (
            <>
              <Fingerprint className="w-4 h-4 mr-2" />
              Approve
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
