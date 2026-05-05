import {
  ShieldCheck,
  ShieldX,
  RotateCcw,
  User,
  Key,
  Hash,
  Clock,
  AlertTriangle,
} from 'lucide-react'
import type { VerifyResult } from '../api'

interface VerificationResultProps {
  result: VerifyResult
  onReset: () => void
}

// Attributes safe to display (no PII concern)
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

// Attributes to hide from display (internal/cryptographic)
const HIDDEN_KEYS = new Set(['issuerKey', 'ownerKey', 'ownerKeys', 'rootHash', 'salt'])

export function VerificationResult({ result, onReset }: VerificationResultProps) {
  const subjects = result.subjects || {}

  // Filter visible attributes
  const visibleAttrs = Object.entries(subjects).filter(([key]) => !HIDDEN_KEYS.has(key))

  const issuerKey = subjects.issuerKey as string | undefined
  const rootHash = subjects.rootHash as string | undefined

  return (
    <div className="space-y-4">
      {/* Result banner */}
      <div
        className={`flex items-center gap-3 p-4 rounded-xl border ${
          result.valid ? 'bg-green-500/10 border-green-500/20' : 'bg-red-500/10 border-red-500/20'
        }`}
      >
        {result.valid ? (
          <ShieldCheck className="w-8 h-8 text-green-400 shrink-0" />
        ) : (
          <ShieldX className="w-8 h-8 text-red-400 shrink-0" />
        )}
        <div>
          <p className={`font-semibold ${result.valid ? 'text-green-400' : 'text-red-400'}`}>
            {result.valid ? 'Proof Verified' : 'Verification Failed'}
          </p>
          <p className="text-sm text-zinc-400">
            {result.valid
              ? 'This credential proof is cryptographically valid'
              : result.error || 'The proof could not be verified'}
          </p>
        </div>
      </div>

      {/* Disclosed attributes */}
      {result.valid && visibleAttrs.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-zinc-900 overflow-hidden">
          <div className="px-4 py-3 border-b border-white/10">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <User className="w-4 h-4 text-blue-400" />
              Disclosed Attributes
            </h3>
          </div>
          <div className="divide-y divide-white/5">
            {visibleAttrs.map(([key, value]) => (
              <div key={key} className="px-4 py-2.5 flex justify-between items-center">
                <span className="text-sm text-zinc-400">{DISPLAY_LABELS[key] || key}</span>
                <span className="text-sm font-medium font-mono">{formatValue(value)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Cryptographic details */}
      {result.valid && (issuerKey || rootHash) && (
        <div className="rounded-xl border border-white/10 bg-zinc-900 overflow-hidden">
          <div className="px-4 py-3 border-b border-white/10">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <Key className="w-4 h-4 text-zinc-500" />
              Cryptographic Details
            </h3>
          </div>
          <div className="divide-y divide-white/5">
            {issuerKey && (
              <div className="px-4 py-2.5">
                <span className="text-xs text-zinc-500 block">Issuer Public Key</span>
                <span className="text-xs font-mono text-zinc-400 break-all">{issuerKey}</span>
              </div>
            )}
            {rootHash && (
              <div className="px-4 py-2.5">
                <span className="text-xs text-zinc-500 block">Credential Root Hash</span>
                <span className="text-xs font-mono text-zinc-400 break-all">{rootHash}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Error details */}
      {!result.valid && result.error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-zinc-900 border border-white/10 text-sm">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-zinc-400">Reason: {result.error}</p>
          </div>
        </div>
      )}

      {/* Verify another */}
      <button
        onClick={onReset}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-white/10 text-sm hover:bg-zinc-800 transition-colors"
      >
        <RotateCcw className="w-4 h-4" />
        Verify Another
      </button>
    </div>
  )
}

function formatValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}
