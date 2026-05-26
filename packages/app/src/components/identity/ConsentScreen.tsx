/**
 * Consent Screen — multi-credential aware with per-query overrides.
 *
 * Renders the wallet's DCQL match summary as a per-card breakdown plus
 * an explicit cross-credential linkage banner when the presentation
 * draws claims from more than one credential. When a DCQL query has
 * multiple candidate credentials, the holder can swap which one
 * answers via a per-row Select.
 */

import { Shield, Check, X, Fingerprint, AlertTriangle, Link2 } from 'lucide-react'
import { Button } from '@owlid/ui/components/ui/button'
import { Badge } from '@owlid/ui/components/ui/badge'
import { Spinner } from '@owlid/ui/components/ui/spinner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@owlid/ui/components/ui/select'
import type { DcqlMatchSummary, PresentationRequest, WalletCredential } from '@owlid/sdk'
import { friendlyDcqlLabel, friendlyDcqlPath } from '~/utils/dcql-labels'

interface ConsentScreenProps {
  request: PresentationRequest
  /** Wallet's match summary for the request. `null` while loading. */
  matchSummary: DcqlMatchSummary | null
  /** Holder-chosen credentialId per DCQL query id (empty = wallet
   *  default, newest matching credential). */
  overrides: Record<string, string>
  /** Swap the credential answering a DCQL query before approve. */
  onSelectCredential: (dcqlId: string, credentialId: string) => void
  isGenerating: boolean
  onApprove: () => void
  onDeny: () => void
}

interface ChosenEntry {
  dcqlId: string
  candidates: WalletCredential[]
  credential: WalletCredential | null
  disclosures: string[]
}

function describeCard(cred: WalletCredential): string {
  switch (cred.cardShape.kind) {
    case 'passport': {
      const c = cred.verifiedClaims
      const name = [c.firstName, c.lastName].filter(Boolean).join(' ')
      return name || cred.providerId
    }
    case 'google-account':
      return cred.verifiedClaims.email || 'Google account'
    case 'apple-id':
      return cred.verifiedClaims.email || 'Apple ID'
    case 'generic-oidc':
      return cred.cardShape.brandName
  }
}

function cardKindLabel(cred: WalletCredential): string {
  switch (cred.cardShape.kind) {
    case 'passport':
      return 'Passport'
    case 'google-account':
      return 'Google'
    case 'apple-id':
      return 'Apple ID'
    case 'generic-oidc':
      return cred.cardShape.brandName
  }
}

function pickDefault(candidates: WalletCredential[]): WalletCredential | null {
  if (candidates.length === 0) return null
  return [...candidates].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))[0]!
}

export function ConsentScreen({
  request,
  matchSummary,
  overrides,
  onSelectCredential,
  isGenerating,
  onApprove,
  onDeny,
}: ConsentScreenProps) {
  const chosen: ChosenEntry[] =
    matchSummary?.entries.map((entry) => {
      const overrideId = overrides[entry.dcqlId]
      const explicit = overrideId
        ? entry.candidates.find((c) => c.credentialId === overrideId)
        : undefined
      return {
        dcqlId: entry.dcqlId,
        candidates: entry.candidates,
        credential: explicit ?? pickDefault(entry.candidates),
        disclosures: entry.disclosures,
      }
    }) ?? []

  const usedCardIds = new Set(
    chosen.filter((e) => e.credential).map((e) => e.credential!.credentialId),
  )
  const linksMultipleCards = usedCardIds.size > 1
  const cannotFulfill = matchSummary !== null && !matchSummary.satisfiable

  return (
    <div className="flex flex-col items-center gap-6 w-full max-w-sm mx-auto">
      <div className="flex flex-col items-center gap-2">
        <div className="w-14 h-14 rounded-full bg-white/5 border border-white/10 flex items-center justify-center">
          <Shield className="w-7 h-7 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-semibold text-white">{request.verifierName}</h3>
        <p className="text-sm text-zinc-400 text-center">wants to verify the following</p>
      </div>

      <div className="w-full rounded-xl border border-white/10 bg-zinc-900/50 divide-y divide-white/5">
        {matchSummary === null ? (
          <div className="flex items-center gap-2 px-4 py-3 text-sm text-zinc-400">
            <Spinner className="w-3.5 h-3.5" />
            Resolving credentials…
          </div>
        ) : chosen.length === 0 ? (
          <div className="px-4 py-3 text-sm text-zinc-400">No claims requested.</div>
        ) : (
          chosen.map((entry) => (
            <div key={entry.dcqlId} className="px-4 py-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div
                    className={
                      'w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 ' +
                      (entry.credential ? 'bg-emerald-500/10' : 'bg-red-500/10')
                    }
                  >
                    {entry.credential ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <X className="w-3.5 h-3.5 text-red-400" />
                    )}
                  </div>
                  <div className="min-w-0">
                    {entry.credential ? (
                      <>
                        <div className="text-sm text-zinc-200 truncate">
                          {describeCard(entry.credential)}
                        </div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          {cardKindLabel(entry.credential)}
                        </div>
                      </>
                    ) : (
                      <div className="text-sm text-red-300">
                        No card answers {friendlyDcqlLabel(entry.dcqlId, request)}
                      </div>
                    )}
                  </div>
                </div>
                <Badge variant="outline" className="text-[10px] border-white/10 text-white/60">
                  {friendlyDcqlLabel(entry.dcqlId, request)}
                </Badge>
              </div>
              {entry.disclosures.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {entry.disclosures.map((d) => (
                    <Badge
                      key={d}
                      variant="outline"
                      className="text-[10px] border-amber-500/40 text-amber-300"
                    >
                      {friendlyDcqlPath([d])}
                    </Badge>
                  ))}
                </div>
              )}
              {entry.candidates.length > 1 && entry.credential && (
                <Select
                  value={entry.credential.credentialId}
                  onValueChange={(v) => onSelectCredential(entry.dcqlId, v)}
                >
                  <SelectTrigger className="h-8 text-xs border-white/10 bg-zinc-900/60">
                    <SelectValue placeholder="Use another card" />
                  </SelectTrigger>
                  <SelectContent>
                    {entry.candidates.map((c) => (
                      <SelectItem key={c.credentialId} value={c.credentialId} className="text-xs">
                        {describeCard(c)} · {cardKindLabel(c)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          ))
        )}
      </div>

      {linksMultipleCards && (
        <div className="w-full flex items-start gap-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2">
          <Link2 className="w-4 h-4 text-violet-300 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-violet-200 leading-relaxed">
            The verifier will see that all selected cards belong to the same wallet. Across
            verifiers (different presentations) you stay unlinkable.
          </p>
        </div>
      )}

      {cannotFulfill && (
        <div className="w-full flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
          <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-red-200 leading-relaxed">
            {matchSummary?.reason ??
              "Your wallet doesn't have a card that answers every claim the verifier asked for."}{' '}
            Add the missing credential first, or Deny — sending now would be rejected.
          </p>
        </div>
      )}

      <p className="text-xs text-zinc-500 text-center leading-relaxed">
        Only the listed claims are disclosed. Everything else stays on this device.
      </p>

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
          disabled={isGenerating || cannotFulfill}
          className="flex-1 bg-white text-black hover:bg-white/90 disabled:bg-white/40 disabled:text-black/50"
          data-testid="button-consent-approve"
          title={
            cannotFulfill ? 'Your wallet is missing a credential the verifier requires.' : undefined
          }
        >
          {isGenerating ? (
            <>
              <Spinner className="w-4 h-4 mr-2" />
              Generating…
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
