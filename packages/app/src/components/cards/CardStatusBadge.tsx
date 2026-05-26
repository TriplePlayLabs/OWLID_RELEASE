import { Badge } from '@owlid/ui/components/ui/badge'
import type { WalletCredential } from '@owlid/sdk'

interface CardStatusBadgeProps {
  credential: WalletCredential
}

/**
 * Active / Expiring / Expired — derived locally from the credential's
 * `expiresAt`. Revocation status is server-derived and rendered by a
 * separate component once the bulk-status endpoint lands.
 */
export function CardStatusBadge({ credential }: CardStatusBadgeProps) {
  const status = inferStatus(credential.expiresAt)
  if (status === 'active') {
    return (
      <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-300">
        Active
      </Badge>
    )
  }
  if (status === 'expiring') {
    return (
      <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-300">
        Expires soon
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="text-[10px] border-white/20 text-white/60">
      Expired
    </Badge>
  )
}

function inferStatus(expiresAt?: string): 'active' | 'expiring' | 'expired' {
  if (!expiresAt) return 'active'
  const exp = Date.parse(expiresAt)
  if (Number.isNaN(exp)) return 'active'
  const now = Date.now()
  const thirtyDays = 30 * 24 * 60 * 60 * 1000
  if (exp < now) return 'expired'
  if (exp - now < thirtyDays) return 'expiring'
  return 'active'
}
