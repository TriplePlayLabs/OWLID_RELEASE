import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { Key, Lock, Loader2, Fingerprint, Shield } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@owlid/ui/components/ui/button'
import { StepCard } from '~/components/identity/StepCard'
import { useIdentity } from '~/hooks/use-identity'
import { useWebAuthn } from '~/hooks/use-webauthn'
import { storage } from '@owlid/sdk'
import { readAuthState } from '~/lib/auth-gate'
import { startWalletSession } from '~/lib/wallet-session'

export const Route = createFileRoute('/_identity/login')({
  beforeLoad: async () => {
    const state = await readAuthState()
    if (state.kind === 'unregistered') {
      throw redirect({ to: '/register', replace: true })
    }
    // 'unknown' (SSR) or any has-passkey state: render the login page.
  },
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const { credentialId } = useIdentity()
  const [isLoading, setIsLoading] = useState(false)
  const [isLoggedIn, setIsLoggedIn] = useState(false)

  const { authenticate } = useWebAuthn()

  const handleLogin = async () => {
    setIsLoading(true)

    try {
      const assertion = await authenticate(credentialId)

      if (assertion) {
        setIsLoggedIn(true)
        startWalletSession()
        toast.success('Login Successful', {
          description: 'Identity verified via Passkey.',
        })
        // Navigate based on whether credential already exists
        const hasCredential = await storage.hasAnyCredential()
        if (hasCredential) {
          navigate({ to: '/wallet' })
        } else {
          navigate({ to: '/add-provider' })
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

  return (
    <div className="w-full max-w-md mx-auto px-4 pt-8 pb-12">
      <div className="space-y-4">
        {/* Step 1: Complete */}
        <StepCard
          isActive={false}
          isCompleted={true}
          icon={<Fingerprint className="w-5 h-5" />}
          title="Set up your passkey"
          description="Use the passkey saved for this wallet."
        />

        {/* Step 2: Active */}
        <StepCard
          isActive={true}
          isCompleted={isLoggedIn}
          icon={<Key className="w-5 h-5" />}
          title="Sign in with your device"
          description="Use your face, fingerprint, device PIN, or password manager."
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
    </div>
  )
}
