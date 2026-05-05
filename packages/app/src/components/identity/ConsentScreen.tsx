/**
 * Consent Screen
 *
 * Shows what the verifier is requesting and lets the holder approve or deny.
 * Displayed after the verifier sends a PresentationRequest over the back-channel.
 */

import { Shield, Check, X, Fingerprint, AlertTriangle } from 'lucide-react'
import { Button } from '@owlid/ui/components/ui/button'
import { Spinner } from '@owlid/ui/components/ui/spinner'
import type { PresentationRequest } from '@owlid/sdk'
import type { PredicateCheck } from '~/hooks/use-presentation'

interface ConsentScreenProps {
  request: PresentationRequest
  /**
   * Pre-flight evaluation of each requested predicate against the holder's
   * local credential. `null` while still loading. Pure-local — never crosses
   * the wire, so it's safe to render in plaintext here.
   */
  predicateChecks: PredicateCheck[] | null
  isGenerating: boolean
  onApprove: () => void
  onDeny: () => void
}

export function ConsentScreen({
  request,
  predicateChecks,
  isGenerating,
  onApprove,
  onDeny,
}: ConsentScreenProps) {
  const checkById = new Map(predicateChecks?.map((c) => [c.id, c]) ?? [])
  const hasUnmet =
    !!predicateChecks && predicateChecks.length > 0 && predicateChecks.some((c) => !c.satisfied)
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
        {request.requestedPredicates.map((predicate) => {
          const check = checkById.get(predicate.id)
          const satisfied = check?.satisfied
          return (
            <div key={predicate.id} className="flex items-center gap-3 px-4 py-3">
              <div
                className={
                  'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ' +
                  (satisfied === false
                    ? 'bg-red-500/10'
                    : satisfied === true
                      ? 'bg-emerald-500/10'
                      : 'bg-zinc-500/10')
                }
              >
                {satisfied === false ? (
                  <X className="w-4 h-4 text-red-400" />
                ) : (
                  <Check
                    className={
                      'w-4 h-4 ' + (satisfied === true ? 'text-emerald-400' : 'text-zinc-400')
                    }
                  />
                )}
              </div>
              <span className="text-sm text-zinc-200 flex-1">{predicate.label}</span>
              {satisfied === false && (
                <span className="text-xs text-red-300/90">won't satisfy</span>
              )}
            </div>
          )
        })}
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

      {hasUnmet && (
        <div className="w-full flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-amber-200 leading-relaxed">
            One or more requirements won't be met. You can still send a response — the verifier will
            receive a "verification failed" outcome with no details about your data.
          </p>
        </div>
      )}

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
