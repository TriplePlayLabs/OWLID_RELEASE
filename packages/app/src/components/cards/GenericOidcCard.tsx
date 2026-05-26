import { KeyRound, CheckCircle2 } from 'lucide-react'
import { Badge } from '@owlid/ui/components/ui/badge'
import type { WalletCredential } from '@owlid/sdk'
import { CardStatusBadge } from './CardStatusBadge'
import { getBrandIcon } from '~/components/identity/ProviderBrandIcon'

interface GenericOidcCardProps {
  credential: WalletCredential
  onClick?: () => void
}

export function GenericOidcCard({ credential, onClick }: GenericOidcCardProps) {
  const c = credential.verifiedClaims
  const brand =
    credential.cardShape.kind === 'generic-oidc'
      ? credential.cardShape.brandName
      : credential.providerId
  const displayName = c.name || c.email || brand
  const Brand = getBrandIcon(credential.providerId)

  const Wrapper = onClick ? 'button' : 'div'
  return (
    <Wrapper
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={`block w-full text-left h-56 rounded-2xl overflow-hidden border border-indigo-500/30 bg-zinc-950 bg-gradient-to-br from-indigo-950 via-slate-900 to-zinc-950 shadow-xl transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-400/50 ${
        onClick ? 'hover:border-indigo-400/60 cursor-pointer' : ''
      }`}
      data-testid={`card-oidc-${credential.credentialId}`}
    >
      <div className="h-full w-full flex flex-col p-5">
        <div className="flex items-start justify-between">
          <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-indigo-200/80">
            {Brand ? (
              <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-white/90">
                <Brand className="w-3.5 h-3.5" />
              </span>
            ) : (
              <KeyRound className="w-3.5 h-3.5" />
            )}
            {brand}
          </span>
          <CardStatusBadge credential={credential} />
        </div>

        <div className="mt-auto flex items-end gap-4">
          <div className="w-16 h-16 rounded-md bg-white/5 border border-indigo-500/40 flex items-center justify-center shrink-0 text-xl font-bold text-indigo-100">
            {(displayName[0] ?? '?').toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-[0.2em] text-indigo-200/60 mb-0.5">
              Account
            </div>
            <div className="font-semibold text-white truncate text-lg leading-tight">
              {displayName}
            </div>
            {c.email && (
              <div className="text-xs text-muted-foreground truncate mt-0.5 lowercase">
                {c.email}
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {c.emailVerified && (
                <Badge
                  variant="outline"
                  className="text-[10px] border-emerald-500/40 text-emerald-300"
                >
                  <CheckCircle2 className="w-3 h-3 mr-1" />
                  verified
                </Badge>
              )}
              {c.hostedDomain && (
                <Badge
                  variant="outline"
                  className="text-[10px] border-violet-500/40 text-violet-300"
                >
                  {c.hostedDomain}
                </Badge>
              )}
            </div>
          </div>
        </div>
      </div>
    </Wrapper>
  )
}
