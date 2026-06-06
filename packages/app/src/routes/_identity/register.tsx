import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Fingerprint, ChevronRight, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@owlid/ui/components/ui/button'
import { Input } from '@owlid/ui/components/ui/input'
import { StepCard } from '~/components/identity/StepCard'
import { useIdentity } from '~/hooks/use-identity'
import { useWebAuthn } from '~/hooks/use-webauthn'
import { storage } from '@owlid/sdk'
import { readAuthState, ROUTE_FOR_STATE } from '~/lib/auth-gate'

export const Route = createFileRoute('/_identity/register')({
  beforeLoad: async () => {
    const state = await readAuthState()
    if (state.kind === 'unknown' || state.kind === 'unregistered') return
    throw redirect({ to: ROUTE_FOR_STATE[state.kind], replace: true })
  },
  component: RegisterPage,
})

function RegisterPage() {
  const navigate = useNavigate()
  const { completeRegistration } = useIdentity()
  // `isRegistered` is keyed off the actual passkey gate, not the
  // username string — a stale username with no passkey would otherwise
  // render the form as already-completed (input disabled, button hidden).
  const passkeyQuery = useQuery({
    queryKey: ['identity', 'has-passkey'],
    queryFn: () => storage.hasWebAuthnCredential(),
    refetchOnMount: 'always',
  })
  const isRegistered = passkeyQuery.data === true
  const [username, setUsername] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const { register } = useWebAuthn()

  const usernameError = useMemo(() => {
    if (!username) return ''
    if (username.length < 2) return 'Username must be at least 2 characters.'
    if (username.length > 50) return 'Username must be 50 characters or fewer.'
    if (!/^[a-zA-Z0-9_-]+$/.test(username))
      return 'Only letters, numbers, underscores, and hyphens are allowed.'
    return ''
  }, [username])

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
        completeRegistration(username)
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

  return (
    <div className="w-full max-w-md mx-auto px-4 pt-8 pb-12">
      <div className="space-y-4">
        <StepCard
          isActive={true}
          isCompleted={isRegistered}
          icon={<Fingerprint className="w-5 h-5" />}
          title="Create your account"
          description="Choose a username, then create a saved passkey for this wallet."
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
                Create account
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
          description="Use your face, fingerprint, device PIN, or password manager."
        />

        <StepCard
          isActive={false}
          isDisabled={true}
          icon={<span className="w-5 h-5 text-muted-foreground">3</span>}
          title="Create your Owl ID"
          description="Connect a provider to create your digital ID."
        />
      </div>
    </div>
  )
}
