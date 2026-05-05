import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo } from 'react'
import { Fingerprint, ChevronRight, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { StepCard } from '~/components/identity/StepCard'
import { IdentityHeader } from '~/components/identity/IdentityHeader'
import { useIdentityContext } from '~/contexts/identity-context'
import { useWebAuthn } from '~/hooks/use-webauthn'
import { storage, type StoredWebAuthnCredential } from '@owlid/sdk'

export const Route = createFileRoute('/_identity/register')({
  component: RegisterPage,
})

function RegisterPage() {
  const navigate = useNavigate()
  const {
    username,
    setUsername,
    isRegistered,
    isLoading,
    setIsLoading,
    completeRegistration,
    resetDemo,
  } = useIdentityContext()

  const { register } = useWebAuthn()

  const usernameError = useMemo(() => {
    if (!username) return ''
    if (username.length < 2) return 'Username must be at least 2 characters.'
    if (username.length > 50) return 'Username must be 50 characters or fewer.'
    if (!/^[a-zA-Z0-9_-]+$/.test(username))
      return 'Only letters, numbers, underscores, and hyphens are allowed.'
    return ''
  }, [username])

  // Redirect if already registered
  useEffect(() => {
    async function checkAndRedirect() {
      const hasIdentity = await storage.hasStoredIdentity()
      const stored = await storage.loadStoredIdentity()

      if (hasIdentity) {
        // Has full identity - go to locked page
        navigate({ to: '/locked', replace: true })
      } else if (stored.credentialId) {
        // Has passkey but no identity yet - go to login
        navigate({ to: '/login', replace: true })
      }
    }
    checkAndRedirect()
  }, [navigate])

  const handleRegister = async () => {
    if (!username) {
      toast.error('Username required', {
        description: 'Please enter a username to continue.',
      })
      return
    }

    setIsLoading(true)

    try {
      const result = await register(username)

      if (result) {
        // Save full WebAuthn credential for later use in credential issuance
        const webauthnCred: StoredWebAuthnCredential = {
          credentialId: result.credentialId,
          publicKey: result.publicKey,
          counter: result.counter,
          transports: result.transports,
        }
        await storage.saveWebAuthnCredential(webauthnCred)

        completeRegistration(result.credentialId, username)
        toast.success('Registration Successful', {
          description: 'Passkey created. You can now login.',
        })
        navigate({ to: '/login' })
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      console.error(error)
      toast.error('Registration Failed', {
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
        <StepCard
          isActive={true}
          isCompleted={isRegistered}
          icon={<Fingerprint className="w-5 h-5" />}
          title="Set up your passkey"
          description="Set up a secure key on this device for sign in."
        >
          <div className="space-y-4 mt-4">
            <div className="space-y-2">
              <label
                htmlFor="username"
                className="text-xs font-medium text-muted-foreground tracking-wider"
              >
                Username
              </label>
              <Input
                id="username"
                placeholder="Enter a username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={isRegistered || isLoading}
                maxLength={50}
                className="bg-secondary/50 border-transparent focus:border-white/20 transition-all font-mono h-12 text-base"
                data-testid="input-username"
              />
              {usernameError && <p className="text-xs text-destructive mt-1">{usernameError}</p>}
            </div>
            {!isRegistered && (
              <Button
                onClick={handleRegister}
                disabled={isLoading || !username || !!usernameError}
                className="w-full bg-white text-black hover:bg-white/90 transition-all h-12 text-base font-medium"
                data-testid="button-register"
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : (
                  <ChevronRight className="w-4 h-4 mr-2" />
                )}
                Set up passkey
              </Button>
            )}
          </div>
        </StepCard>

        {/* Placeholder for subsequent steps (inactive) */}
        <StepCard
          isActive={false}
          isDisabled={true}
          icon={<span className="w-5 h-5 text-muted-foreground">2</span>}
          title="Sign in with your device"
          description="Sign in using your face, fingerprint or device PIN."
        />

        <StepCard
          isActive={false}
          isDisabled={true}
          icon={<span className="w-5 h-5 text-muted-foreground">3</span>}
          title="Create your Owl ID"
          description="Connect a provider to create your digital ID."
        />
      </div>
    </>
  )
}
