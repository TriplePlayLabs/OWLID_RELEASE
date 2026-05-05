import { ShieldCheck, ShieldX, RotateCcw, User, Key, AlertTriangle } from 'lucide-react'
import type { VerifyResult } from '../api'
import { Badge } from '@owlid/ui/components/ui/badge'
import { Button } from '@owlid/ui/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@owlid/ui/components/ui/card'

interface VerificationResultProps {
  result: VerifyResult
  onReset: () => void
}

const DISPLAY_LABELS: Record<string, string> = {
  firstName: 'First Name',
  lastName: 'Last Name',
  dateOfBirth: 'Date of Birth',
  nationality: 'Nationality',
  isOver18: 'Over 18',
  isOver21: 'Over 21',
  isOver65: 'Over 65',
  isEuCitizen: 'EU Citizen',
  isResident: 'Resident',
  verificationLevel: 'Verification Level',
  verifiedBy: 'Verified By',
  verifiedAt: 'Verified At',
}

const HIDDEN_KEYS = new Set(['issuerKey', 'ownerKey', 'ownerKeys', 'rootHash', 'salt'])

export function VerificationResult({ result, onReset }: VerificationResultProps) {
  const subjects = result.subjects || {}
  const visibleAttrs = Object.entries(subjects).filter(([key]) => !HIDDEN_KEYS.has(key))
  const issuerKey = subjects.issuerKey as string | undefined
  const rootHash = subjects.rootHash as string | undefined

  return (
    <div className="space-y-4">
      <Card
        className={
          result.valid ? 'border-green-500/30 bg-green-500/10' : 'border-red-500/30 bg-red-500/10'
        }
      >
        <CardContent className="flex items-center gap-3 py-4">
          {result.valid ? (
            <ShieldCheck className="h-8 w-8 shrink-0 text-green-400" />
          ) : (
            <ShieldX className="h-8 w-8 shrink-0 text-red-400" />
          )}
          <div className="space-y-0.5">
            <p className={`font-semibold ${result.valid ? 'text-green-400' : 'text-red-400'}`}>
              {result.valid ? 'Proof Verified' : 'Verification Failed'}
            </p>
            <p className="text-sm text-muted-foreground">
              {result.valid
                ? 'This credential proof is cryptographically valid'
                : result.error || 'The proof could not be verified'}
            </p>
          </div>
        </CardContent>
      </Card>

      {result.valid && visibleAttrs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <User className="h-4 w-4 text-blue-400" />
              Disclosed Attributes
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {visibleAttrs.map(([key, value]) => (
                <li key={key} className="flex items-center justify-between px-6 py-2.5">
                  <span className="text-sm text-muted-foreground">
                    {DISPLAY_LABELS[key] || key}
                  </span>
                  <ValueBadge value={value} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {result.valid && (issuerKey || rootHash) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Key className="h-4 w-4 text-muted-foreground" />
              Cryptographic Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs font-mono break-all">
            {issuerKey && (
              <div>
                <p className="mb-0.5 text-xs font-sans text-muted-foreground">Issuer Public Key</p>
                <p className="text-muted-foreground">{issuerKey}</p>
              </div>
            )}
            {rootHash && (
              <div>
                <p className="mb-0.5 text-xs font-sans text-muted-foreground">
                  Credential Root Hash
                </p>
                <p className="text-muted-foreground">{rootHash}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!result.valid && result.error && (
        <Card>
          <CardContent className="flex items-start gap-2 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p className="text-muted-foreground">Reason: {result.error}</p>
          </CardContent>
        </Card>
      )}

      <Button variant="outline" className="w-full" onClick={onReset}>
        <RotateCcw className="h-4 w-4" />
        Verify Another
      </Button>
    </div>
  )
}

function ValueBadge({ value }: { value: unknown }) {
  if (typeof value === 'boolean') {
    return (
      <Badge variant={value ? 'default' : 'secondary'} className="font-mono">
        {value ? 'Yes' : 'No'}
      </Badge>
    )
  }
  return <span className="text-sm font-mono">{formatValue(value)}</span>
}

function formatValue(value: unknown): string {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}
