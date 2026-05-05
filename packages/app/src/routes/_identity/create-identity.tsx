import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { Fingerprint, Key, Shield, Loader2, CheckCircle, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { StepCard } from '~/components/identity/StepCard'
import { ProviderSelector } from '~/components/identity/ProviderSelector'
import { useIdentity } from '~/hooks/use-identity'
import { useVerifyAndIssueWithWebAuthn, RedirectingToProviderError } from '~/hooks/use-idp-api'
import { storage, type StoredCredentialData } from '@owlid/sdk'

export const Route = createFileRoute('/_identity/create-identity')({
  component: CreateIdentityPage,
})

function CreateIdentityPage() {
  const navigate = useNavigate()
  const { isIdentityCreated, identityData, username, setIdentityData, completeIdentityCreation } =
    useIdentity()

  // Use WebAuthn-enabled verification - handles all flow types
  const verifyAndIssue = useVerifyAndIssueWithWebAuthn()

  // Redirect to passport if identity already created
  useEffect(() => {
    async function checkCredential() {
      const hasCredential = await storage.hasStoredCredential()
      if (isIdentityCreated || hasCredential) {
        navigate({ to: '/passport', replace: true })
      }
    }
    checkCredential()
  }, [isIdentityCreated, navigate])

  // Redirect to login if the user has not unlocked / created identity yet.
  // `identityData` is populated only after a successful unlock or callback.
  if (!identityData) {
    navigate({ to: '/login' })
    return null
  }

  const handleProviderSelect = async (providerId: string) => {
    try {
      // Hook handles all flow types - redirects for webhook_async/saml, auto-verify for form_based
      const result = await verifyAndIssue.mutateAsync({
        providerId,
        username: username || 'user',
      })

      // Redirect flows return a sentinel object; the page is navigating away
      if ((result as unknown as { redirected?: boolean }).redirected) {
        return
      }

      handleVerificationSuccess(result)
    } catch (error) {
      // Ignore redirect sentinel errors (in case the hook throws instead of returning)
      if (error instanceof RedirectingToProviderError) {
        return
      }
      console.error('Verification failed:', error)
      toast.error('Verification Failed', {
        description: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  const handleVerificationSuccess = (data: StoredCredentialData) => {
    // Convert verified claims to IdentityData format
    const claims = data.verifiedClaims
    const identityFromClaims = {
      firstName: claims.firstName || '',
      lastName: claims.lastName || '',
      birthDate: claims.dateOfBirth || '',
      birthPlace: String(claims.placeOfBirth || ''),
      nationality: claims.nationality || '',
      nationalId: String(claims.nationalId || ''),
      passportNumber: String(claims.passportNumber || claims.documentNumber || ''),
      taxId: String(claims.taxId || ''),
      creditScore: 750,
      accountNumber: '',
      email: '',
      phone: '',
      address: `${claims.streetAddress || ''}, ${claims.city || ''}, ${claims.postalCode || ''}, ${claims.country || ''}`,
      occupation: '',
      employer: '',
      maritalStatus: '',
      // Portrait image from document verification (base64)
      portraitImage: claims.portraitImage,
    }

    setIdentityData(identityFromClaims)
    completeIdentityCreation(identityFromClaims)

    toast.success('Identity Created', {
      description: 'Your Owl ID has been cryptographically minted and stored.',
    })

    navigate({ to: '/passport' })
  }

  return (
    <div className="my-auto w-full max-w-md mx-auto px-4 py-8">
      <div className="space-y-4">
        {/* Step 1: Complete */}
        <StepCard
          isActive={false}
          isCompleted={true}
          icon={<Fingerprint className="w-5 h-5" />}
          title="Set up your passkey"
          description="Set up a secure key on this device for sign in."
        />

        {/* Step 2: Complete */}
        <StepCard
          isActive={false}
          isCompleted={true}
          icon={<Key className="w-5 h-5" />}
          title="Sign in with your device"
          description="Sign in using your face, fingerprint or device PIN."
        />

        {/* Step 3: Active */}
        <StepCard
          isActive={true}
          isDisabled={false}
          isCompleted={isIdentityCreated}
          icon={<Shield className="w-5 h-5" />}
          title="Create your Owl ID"
          description="Connect a provider to create your digital ID."
        >
          <div className="space-y-4 mt-4">
            {!identityData ? (
              <>
                {/* Error message (suppress redirect sentinel — those are intentional navigation) */}
                {verifyAndIssue.isError &&
                  !(verifyAndIssue.error instanceof RedirectingToProviderError) && (
                    <div className="flex items-center gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span>{verifyAndIssue.error?.message || 'Verification failed'}</span>
                    </div>
                  )}

                {/* Redirecting to external provider */}
                {verifyAndIssue.isError &&
                  verifyAndIssue.error instanceof RedirectingToProviderError && (
                    <div className="flex flex-col items-center justify-center py-8 space-y-4">
                      <Loader2 className="w-8 h-8 animate-spin text-primary" />
                      <div className="text-center">
                        <p className="font-medium">Redirecting to identity provider...</p>
                        <p className="text-sm text-muted-foreground">
                          You will be redirected to complete verification
                        </p>
                      </div>
                    </div>
                  )}

                {/* Loading state */}
                {verifyAndIssue.isPending ? (
                  <div className="flex flex-col items-center justify-center py-8 space-y-4">
                    <Loader2 className="w-8 h-8 animate-spin text-primary" />
                    <div className="text-center">
                      <p className="font-medium">Verifying your identity...</p>
                      <p className="text-sm text-muted-foreground">
                        Connecting to identity provider
                      </p>
                    </div>
                  </div>
                ) : verifyAndIssue.isSuccess ? (
                  <div className="flex flex-col items-center justify-center py-8 space-y-4">
                    <CheckCircle className="w-8 h-8 text-green-500" />
                    <div className="text-center">
                      <p className="font-medium">Identity verified!</p>
                      <p className="text-sm text-muted-foreground">
                        Redirecting to your passport...
                      </p>
                    </div>
                  </div>
                ) : (
                  <ProviderSelector
                    onSelect={(provider) => handleProviderSelect(provider.id)}
                    disabled={verifyAndIssue.isPending}
                  />
                )}
              </>
            ) : (
              <div className="text-center py-4">
                <p className="text-sm text-muted-foreground">
                  Identity already created. View your passport.
                </p>
              </div>
            )}
          </div>
        </StepCard>
      </div>
    </div>
  )
}
