import { CircleCheck, CircleX, RotateCcw, BadgeCheck, Fingerprint } from 'lucide-react'
import type { VerifyResult } from '../api'
import { friendlyCheckLabel } from '../dcql-labels'
import { Badge } from '@owlid/ui/components/ui/badge'
import { Button } from '@owlid/ui/components/ui/button'
import { Card, CardContent } from '@owlid/ui/components/ui/card'

interface VerificationResultProps {
  result: VerifyResult
  onReset: () => void
  /** Campaign name when this was a unique-personhood request. */
  campaign?: string
}

const HIDDEN_KEYS = new Set(['issuerKey', 'ownerKey', 'ownerKeys', 'rootHash', 'salt'])

/** A real disclosed value vs. an empty-object placeholder. Under the
 *  Midnight-only policy the verifier learns "this check passed", never a
 *  claim value — the placeholder is the normal case. */
function hasDisclosedValue(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  if (typeof v === 'string') return v.length > 0
  return true
}

function formatValue(value: unknown): string {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return JSON.stringify(value)
}

/** One verification result — a single card: status, the checks the
 *  holder passed, and (for a campaign) the one-claim-per-person note. */
export function VerificationResult({ result, onReset, campaign }: VerificationResultProps) {
  const checks = Object.entries(result.subjects || {}).filter(([k]) => !HIDDEN_KEYS.has(k))

  return (
    <div className="space-y-3">
      {/* `py-0 gap-0` strips the shadcn Card's built-in vertical padding
          so the sections below own all the spacing. */}
      <Card className={`gap-0 py-0 ${result.valid ? 'border-green-500/25' : 'border-red-500/25'}`}>
        <CardContent className="p-0">
          <div className="flex items-start gap-3 p-5">
            {result.valid ? (
              <CircleCheck className="mt-0.5 h-7 w-7 shrink-0 text-green-400" />
            ) : (
              <CircleX className="mt-0.5 h-7 w-7 shrink-0 text-red-400" />
            )}
            <div className="space-y-0.5">
              <p className={`font-semibold ${result.valid ? 'text-green-400' : 'text-red-400'}`}>
                {result.valid ? 'Verified' : 'Could not verify'}
              </p>
              <p className="text-sm text-muted-foreground">
                {result.valid
                  ? 'Every requested check passed on Midnight — no personal data was shared.'
                  : result.error || 'The holder’s proof could not be verified.'}
              </p>
            </div>
          </div>

          {result.valid && checks.length > 0 && (
            <ul className="divide-y border-t">
              {checks.map(([key, value]) => (
                <li key={key} className="flex items-center justify-between gap-3 px-5 py-3">
                  <span className="text-sm">{friendlyCheckLabel(key)}</span>
                  {hasDisclosedValue(value) ? (
                    <span className="font-mono text-sm text-white">{formatValue(value)}</span>
                  ) : (
                    <Badge className="gap-1 border-green-500/40 bg-green-500/10 text-green-300">
                      <BadgeCheck className="h-3 w-3" />
                      Confirmed
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}

          {result.valid && campaign && (
            <div className="flex items-center gap-2 border-t px-5 py-3 text-xs text-muted-foreground">
              <Fingerprint className="h-3.5 w-3.5 shrink-0" />
              Campaign “{campaign}” — one claim per person, the same human cannot claim twice.
            </div>
          )}
        </CardContent>
      </Card>

      <Button variant="outline" className="w-full" onClick={onReset}>
        <RotateCcw className="h-4 w-4" />
        Verify another
      </Button>
    </div>
  )
}
