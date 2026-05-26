import { Briefcase, CheckCircle2 } from 'lucide-react'
import { Badge } from '@owlid/ui/components/ui/badge'
import type { WalletCredential } from '@owlid/sdk'
import { CardStatusBadge } from './CardStatusBadge'
import { getBrandIcon } from '~/components/identity/ProviderBrandIcon'

interface GoogleAccountCardProps {
  credential: WalletCredential
  onClick?: () => void
}

export function GoogleAccountCard({ credential, onClick }: GoogleAccountCardProps) {
  const c = credential.verifiedClaims
  const hd =
    credential.cardShape.kind === 'google-account' ? credential.cardShape.hostedDomain : undefined
  // The provider name already sits in the top strip; the headline is the
  // user's identity (name) and the secondary line is their email. Fall
  // back gracefully when one or both are missing.
  const displayName = c.name || c.email || 'Signed in'
  const GoogleBrand = getBrandIcon('google')
  const picture = c.pictureUrl

  const Wrapper = onClick ? 'button' : 'div'
  return (
    <Wrapper
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={`block w-full text-left h-56 rounded-2xl overflow-hidden border border-sky-500/30 bg-zinc-950 bg-gradient-to-br from-sky-950 via-slate-900 to-zinc-950 shadow-xl transition-colors focus:outline-none focus:ring-2 focus:ring-sky-400/50 ${
        onClick ? 'hover:border-sky-400/60 cursor-pointer' : ''
      }`}
      data-testid={`card-google-${credential.credentialId}`}
    >
      <div className="h-full w-full flex flex-col p-5">
        <div className="flex items-start justify-between">
          <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-sky-200/80">
            {GoogleBrand ? (
              <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-white">
                <GoogleBrand className="w-3.5 h-3.5" />
              </span>
            ) : null}
            Google Account
          </span>
          <CardStatusBadge credential={credential} />
        </div>

        <div className="mt-auto flex items-end gap-4">
          {picture ? (
            <img
              src={picture}
              alt=""
              className="w-16 h-16 rounded-full object-cover shrink-0 border border-sky-400/40 shadow-md bg-white/10"
              // Google profile hosts (lh3.googleusercontent.com) 403 the
              // request when a Referer header is sent from a non-Google
              // origin. `no-referrer` strips it.
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="w-16 h-16 rounded-full bg-white/10 border border-sky-400/40 flex items-center justify-center shrink-0 text-xl font-bold text-sky-100">
              {(displayName[0] ?? 'G').toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-[0.2em] text-sky-200/60 mb-0.5">
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
              {hd && (
                <Badge
                  variant="outline"
                  className="text-[10px] border-violet-500/40 text-violet-300"
                >
                  <Briefcase className="w-3 h-3 mr-1" />
                  {hd}
                </Badge>
              )}
              {c.locale && (
                <Badge variant="outline" className="text-[10px] border-white/20 text-white/70">
                  {c.locale}
                </Badge>
              )}
            </div>
          </div>
        </div>
      </div>
    </Wrapper>
  )
}
