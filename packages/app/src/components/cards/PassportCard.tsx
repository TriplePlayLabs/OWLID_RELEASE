import { ShieldCheck, IdCard } from 'lucide-react'
import { Badge } from '@owlid/ui/components/ui/badge'
import type { WalletCredential } from '@owlid/sdk'
import { CardStatusBadge } from './CardStatusBadge'

interface PassportCardProps {
  credential: WalletCredential
  onClick?: () => void
}

function portraitSrc(b64?: string): string | undefined {
  if (!b64) return undefined
  if (b64.startsWith('http') || b64.startsWith('data:')) return b64
  return `data:image/jpeg;base64,${b64}`
}

/**
 * Document-grade identity (Didit / DigiD / BankID / future ICAO).
 * Fixed credit-card aspect, navy-amber passport palette, portrait left.
 */
export function PassportCard({ credential, onClick }: PassportCardProps) {
  const c = credential.verifiedClaims
  const portrait = portraitSrc(
    credential.cardShape.kind === 'passport' ? credential.cardShape.portraitImage : undefined,
  )
  const initials = `${c.firstName?.[0] ?? ''}${c.lastName?.[0] ?? ''}`.toUpperCase() || '?'
  const fullName = [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unnamed holder'

  const Wrapper = onClick ? 'button' : 'div'
  return (
    <Wrapper
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={`block w-full text-left h-56 rounded-2xl overflow-hidden border border-amber-600/30 bg-zinc-950 bg-gradient-to-br from-amber-950 via-stone-900 to-zinc-950 shadow-xl transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500/50 ${
        onClick ? 'hover:border-amber-500/60 cursor-pointer' : ''
      }`}
      data-testid={`card-passport-${credential.credentialId}`}
    >
      <div className="h-full w-full flex flex-col p-5">
        <div className="flex items-start justify-between">
          <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.18em] text-amber-200/80">
            <IdCard className="w-3.5 h-3.5" />
            {labelForProvider(credential.providerId)}
          </span>
          <CardStatusBadge credential={credential} />
        </div>

        <div className="mt-auto flex items-end gap-4">
          {portrait ? (
            <img
              src={portrait}
              alt={fullName}
              className="w-20 h-24 rounded object-cover shrink-0 border border-amber-500/40 shadow-md"
            />
          ) : (
            <div className="w-20 h-24 rounded shrink-0 border border-amber-500/40 bg-amber-950/40 flex items-center justify-center text-2xl font-semibold text-amber-200/80">
              {initials}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-[0.2em] text-amber-200/60 mb-0.5">
              Holder
            </div>
            <div className="font-semibold text-white truncate text-lg leading-tight">
              {fullName}
            </div>
            <div className="text-xs text-muted-foreground truncate mt-0.5">
              {[c.nationality, c.documentType].filter(Boolean).join(' · ') || '—'}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {c.isOver18 && (
                <Badge
                  variant="outline"
                  className="text-[10px] border-emerald-500/40 text-emerald-300"
                >
                  age ≥ 18
                </Badge>
              )}
              {c.isEuCitizen && (
                <Badge variant="outline" className="text-[10px] border-sky-500/40 text-sky-300">
                  EU citizen
                </Badge>
              )}
              {c.verificationLevel && (
                <Badge
                  variant="outline"
                  className="text-[10px] border-violet-500/40 text-violet-300"
                >
                  <ShieldCheck className="w-3 h-3 mr-1" />
                  {c.verificationLevel}
                </Badge>
              )}
            </div>
          </div>
        </div>
      </div>
    </Wrapper>
  )
}

function labelForProvider(id: string): string {
  if (id === 'didit') return 'Didit Passport'
  if (id === 'mock-digid') return 'DigiD'
  if (id === 'mock-bankid') return 'BankID'
  return id
}
