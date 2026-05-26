import { CheckCircle2, Eye, EyeOff } from 'lucide-react'
import { Badge } from '@owlid/ui/components/ui/badge'
import type { WalletCredential } from '@owlid/sdk'
import { CardStatusBadge } from './CardStatusBadge'
import { getBrandIcon } from '~/components/identity/ProviderBrandIcon'

interface AppleIdCardProps {
  credential: WalletCredential
  onClick?: () => void
}

export function AppleIdCard({ credential, onClick }: AppleIdCardProps) {
  const c = credential.verifiedClaims
  const isRelay =
    credential.cardShape.kind === 'apple-id'
      ? !!credential.cardShape.relayEmail
      : !!c.isPrivateEmail
  const displayName = c.name || c.email || 'Apple ID'
  const AppleBrand = getBrandIcon('apple')

  const Wrapper = onClick ? 'button' : 'div'
  return (
    <Wrapper
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={`block w-full text-left h-56 rounded-2xl overflow-hidden border border-zinc-400/30 bg-zinc-950 bg-gradient-to-br from-zinc-800 via-stone-900 to-zinc-950 shadow-xl transition-colors focus:outline-none focus:ring-2 focus:ring-white/30 ${
        onClick ? 'hover:border-zinc-300/50 cursor-pointer' : ''
      }`}
      data-testid={`card-apple-${credential.credentialId}`}
    >
      <div className="h-full w-full flex flex-col p-5">
        <div className="flex items-start justify-between">
          <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-white/70">
            {AppleBrand ? <AppleBrand className="w-4 h-4 text-white/85" /> : null}
            Apple ID
          </span>
          <CardStatusBadge credential={credential} />
        </div>

        <div className="mt-auto flex items-end gap-4">
          <div className="w-16 h-16 rounded-full bg-white/5 border border-white/20 flex items-center justify-center shrink-0 text-xl font-bold text-white">
            {(displayName[0] ?? 'A').toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-[0.2em] text-white/50 mb-0.5">
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
              <Badge
                variant="outline"
                className={
                  isRelay
                    ? 'text-[10px] border-amber-500/40 text-amber-300'
                    : 'text-[10px] border-white/20 text-white/70'
                }
              >
                {isRelay ? (
                  <>
                    <EyeOff className="w-3 h-3 mr-1" />
                    private relay
                  </>
                ) : (
                  <>
                    <Eye className="w-3 h-3 mr-1" />
                    real email
                  </>
                )}
              </Badge>
            </div>
          </div>
        </div>
      </div>
    </Wrapper>
  )
}
