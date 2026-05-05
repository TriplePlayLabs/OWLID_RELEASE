import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { PassportBook } from '~/components/identity/PassportBook'
import { ProofBadges } from '~/components/identity/ProofBadges'
import { ProofQRModal } from '~/components/identity/ProofQRModal'
import { PresentationFlow } from '~/components/identity/PresentationFlow'
import { useIdentityContext } from '~/contexts/identity-context'
import { useProofs } from '~/hooks/use-proofs'
import { storage } from '@owlid/sdk'

export const Route = createFileRoute('/_identity/passport')({
  component: PassportPage,
})

function PassportPage() {
  const navigate = useNavigate()
  const { identityData } = useIdentityContext()

  // Use proofs hook for viewing previously generated proofs
  const { generatedProofs, viewingProof, setViewingProof, shareProof } = useProofs()

  const [isPassportOpen, setIsPassportOpen] = useState(false)

  // Redirect based on state - handles page refresh scenarios
  useEffect(() => {
    async function checkAndRedirect() {
      if (!identityData) {
        const hasIdentity = await storage.hasStoredIdentity()
        const hasCredential = await storage.hasStoredCredential()

        // If there's stored identity, go to locked page to re-authenticate
        if (hasIdentity) {
          navigate({ to: '/locked', replace: true })
        } else if (!hasCredential) {
          // No stored identity and no credential - need to create identity
          navigate({ to: '/create-identity', replace: true })
        }
      }
    }
    checkAndRedirect()
  }, [identityData, navigate])

  // Auto-open passport on mount
  useEffect(() => {
    const timer = setTimeout(() => setIsPassportOpen(true), 500)
    return () => clearTimeout(timer)
  }, [])

  if (!identityData) {
    return null
  }

  return (
    <div className="w-full flex flex-col items-center justify-center py-2 animate-in fade-in zoom-in duration-500">
      {/* Click hint above passport */}
      <div className="text-center mb-4 text-muted-foreground text-sm animate-pulse">
        Tap the passport to {isPassportOpen ? 'close' : 'open'}
      </div>

      <PassportBook
        isOpen={isPassportOpen}
        onToggle={() => setIsPassportOpen(!isPassportOpen)}
        identityData={identityData}
      />

      {/* GENERATED PROOFS - Lock Icons */}
      <ProofBadges proofs={generatedProofs} onViewProof={setViewingProof} />

      {/* PRESENT ID - Primary action */}
      <PresentationFlow />

      {/* PROOF QR VIEW MODAL */}
      <ProofQRModal
        proof={viewingProof}
        onClose={() => setViewingProof(null)}
        onShare={shareProof}
      />
    </div>
  )
}
