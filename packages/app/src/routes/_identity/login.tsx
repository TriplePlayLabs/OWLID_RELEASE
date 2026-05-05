import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Key, Lock, Loader2, Fingerprint, Shield } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { StepCard } from '~/components/identity/StepCard'
import { IdentityHeader } from '~/components/identity/IdentityHeader'
import { useIdentityContext } from '~/contexts/identity-context'
import { useWebAuthn } from '~/hooks/use-webauthn'
import { storage } from '@owlid/sdk'

export const Route = createFileRoute('/_identity/login')({
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const {
    credentialId,
    isRegistered,
    isLoggedIn,
    isLoading,
    setIsLoading,
    completeLogin,
    resetDemo,
  } = useIdentityContext()

  const { authenticate } = useWebAuthn()

  // Redirect if not registered
  if (!isRegistered && !credentialId) {
    navigate({ to: '/register' })
    return null
  }

  const handleLogin = async () => {
    setIsLoading(true)

    try {
      const assertion = await authenticate(credentialId)

      if (assertion) {
        completeLogin()
        toast.success('Login Successful', {
          description: 'Identity verified via Passkey.',
        })
        // Navigate based on whether credential already exists
        const hasCredential = await storage.hasStoredCredential()
        if (hasCredential) {
          navigate({ to: '/passport' })
        } else {
          navigate({ to: '/create-identity' })
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      console.error(error)
      toast.error('Authentication Failed', {
        description: message,
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleReset = () => {
    if (confirm('This will clear your local identity and reset. Continue?')) {
      resetDemo()
    }
  }

  return (
    <>
      <IdentityHeader onReset={handleReset} />

      <div className="space-y-4 w-full max-w-md mx-auto">
        {/* Step 1: Complete */}
        <StepCard
          isActive={false}
          isCompleted={true}
          icon={<Fingerprint className="w-5 h-5" />}
          title="Set up your passkey"
          description="Set up a secure key on this device for sign in."
        />

        {/* Step 2: Active */}
        <StepCard
          isActive={true}
          isCompleted={isLoggedIn}
          icon={<Key className="w-5 h-5" />}
          title="Sign in with your device"
          description="Sign in using your face, fingerprint or device PIN."
        >
          {!isLoggedIn && (
            <div className="mt-4">
              <Button
                onClick={handleLogin}
                disabled={isLoading}
                className="w-full bg-white text-black hover:bg-white/90 transition-all h-12 text-base font-medium"
                data-testid="button-login"
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : (
                  <Lock className="w-4 h-4 mr-2" />
                )}
                Sign in with passkey
              </Button>
            </div>
          )}
        </StepCard>

        {/* Step 3: Inactive */}
        <StepCard
          isActive={false}
          isDisabled={true}
          icon={<Shield className="w-5 h-5" />}
          title="Create your Owl ID"
          description="Connect a provider to create your digital ID."
        />
      </div>
    </>
  )
}
