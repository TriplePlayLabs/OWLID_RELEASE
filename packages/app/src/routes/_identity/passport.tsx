import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { History } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { storage, proofStorage } from '@owlid/sdk'
import { PassportBook } from '~/components/identity/PassportBook'
import { ProofBadges } from '~/components/identity/ProofBadges'
import { PresentationTrigger } from '~/features/identity/presentation/PresentationTrigger'
import { ManualProofTrigger } from '~/features/identity/manual-proof/ManualProofModal'
import { useIdentity } from '~/hooks/use-identity'
import { usePredicates } from '~/hooks/use-predicates'
import { getAvailableProofs } from '~/utils/proof-utils'

export const Route = createFileRoute('/_identity/passport')({
  component: PassportPage,
})

function PassportPage() {
  const navigate = useNavigate()
  const { identityData } = useIdentity()
  const [isPassportOpen, setIsPassportOpen] = useState(false)

  const claims = useQuery({
    queryKey: ['identity', 'verified-claims'],
    queryFn: () => storage.getStoredClaims(),
    staleTime: Infinity,
  })
  const credential = useQuery({
    queryKey: ['identity', 'credential', 'allowlist'],
    queryFn: async () => {
      const cd = await storage.loadCredentialData()
      return (
        (cd?.credential as { availablePredicates?: string[] } | undefined)?.availablePredicates ??
        []
      )
    },
    staleTime: Infinity,
  })
  const { data: registry } = usePredicates()
  const availableProofs = getAvailableProofs(claims.data ?? null, registry, credential.data)

  // Lightweight: just the count, used for the "Recent proofs (N)" link.
  const proofCount = useQuery({
    queryKey: ['identity', 'proofs', 'count'],
    queryFn: async () => (await proofStorage.getAllProofs()).length,
    staleTime: 0,
  })

  useEffect(() => {
    async function checkAndRedirect() {
      if (!identityData) {
        const hasIdentity = await storage.hasStoredIdentity()
        const hasCredential = await storage.hasStoredCredential()

        if (hasIdentity) {
          navigate({ to: '/locked', replace: true })
        } else if (!hasCredential) {
          navigate({ to: '/create-identity', replace: true })
        }
      }
    }
    checkAndRedirect()
  }, [identityData, navigate])

  useEffect(() => {
    const timer = setTimeout(() => setIsPassportOpen(true), 500)
    return () => clearTimeout(timer)
  }, [])

  if (!identityData) {
    return null
  }

  return (
    <div className="my-auto w-full max-w-md mx-auto px-4 py-8 flex flex-col items-center animate-in fade-in zoom-in duration-500">
      <p className="text-xs text-muted-foreground/70 mb-3 animate-pulse">
        Tap the passport to {isPassportOpen ? 'close' : 'open'}
      </p>

      <PassportBook
        isOpen={isPassportOpen}
        onToggle={() => setIsPassportOpen(!isPassportOpen)}
        identityData={identityData}
      />

      <ProofBadges proofs={availableProofs} />

      {/* Action bar */}
      <div className="mt-8 w-full grid grid-cols-2 gap-2">
        <PresentationTrigger />
        <ManualProofTrigger />
      </div>

      <button
        type="button"
        onClick={() => navigate({ to: '/recent-proofs' })}
        className="mt-4 inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <History className="w-3.5 h-3.5" />
        <span>Recent proofs</span>
        {typeof proofCount.data === 'number' && proofCount.data > 0 && (
          <span className="ml-0.5 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-white/10 text-[11px] font-medium">
            {proofCount.data}
          </span>
        )}
      </button>
    </div>
  )
}
