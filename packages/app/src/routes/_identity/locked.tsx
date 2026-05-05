import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { Lock, Fingerprint, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '~/components/ui/card'
import { useIdentityContext } from '~/contexts/identity-context'
import { useWebAuthn } from '~/hooks/use-webauthn'
import { storage } from '@owlid/sdk'

export const Route = createFileRoute('/_identity/locked')({
  component: LockedPage,
})

function LockedPage() {
  const navigate = useNavigate()
  const { username, credentialId, unlockIdentity, resetDemo } = useIdentityContext()
  const { unlockWithPasskey } = useWebAuthn()

  const [isLoading, setIsLoading] = useState(false)

  // Guard: redirect if no stored identity (e.g., after reset)
  useEffect(() => {
    async function checkStoredData() {
      try {
        const hasIdentity = await storage.hasStoredIdentity()
        if (!hasIdentity) {
          navigate({ to: '/register', replace: true })
        }
      } catch (err) {
        console.error('Failed to check stored identity:', err)
        toast.error('Storage Error', {
          description: 'Could not read stored identity. Redirecting to registration.',
        })
        navigate({ to: '/register', replace: true })
      }
    }
    checkStoredData()
  }, [navigate])

  const handleUnlockIdentity = async () => {
    setIsLoading(true)

    try {
      const assertion = await unlockWithPasskey(credentialId)

      if (assertion) {
        // Simulate decryption delay
        await new Promise((resolve) => setTimeout(resolve, 800))

        let stored
        try {
          stored = await storage.loadStoredIdentity()
        } catch (storageErr) {
          console.error('Failed to load stored identity:', storageErr)
          throw new Error('Could not read stored identity data')
        }

        if (stored.encryptedBlob) {
          unlockIdentity(stored.encryptedBlob)
          // Navigate based on whether identity credential already exists
          let hasCredential = false
          try {
            hasCredential = await storage.hasStoredCredential()
          } catch (storageErr) {
            console.error('Failed to check stored credential:', storageErr)
          }
          if (hasCredential) {
            navigate({ to: '/passport' })
          } else {
            navigate({ to: '/create-identity' })
          }
        } else {
          throw new Error('No encrypted identity found')
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      console.error(error)
      toast.error('Unlock Failed', {
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
    <div className="w-full max-w-md mx-auto">
      <Card className="border border-white/10 bg-card/50 ring-1 ring-white/20 shadow-[0_0_30px_-10px_rgba(255,255,255,0.1)]">
        <CardHeader className="pb-2 text-center">
          <div className="mx-auto p-4 bg-white/5 rounded-full w-16 h-16 flex items-center justify-center mb-4">
            <Lock className="w-8 h-8 text-white" />
          </div>
          <CardTitle className="text-xl">Identity Locked</CardTitle>
          <CardDescription>
            Your identity is saved for <span className="text-white font-mono">{username}</span>.
            <br />
            Sign in to unlock and view your passport.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6 pb-8">
          <Button
            onClick={handleUnlockIdentity}
            disabled={isLoading}
            className="w-full bg-white text-black hover:bg-white/90 transition-all h-12 text-base font-medium mb-4"
            data-testid="button-unlock"
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
            ) : (
              <Fingerprint className="w-4 h-4 mr-2" />
            )}
            Sign in with passkey
          </Button>

          <Button
            variant="ghost"
            onClick={handleReset}
            className="w-full text-muted-foreground hover:text-white text-xs"
          >
            Reset and create new identity
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
