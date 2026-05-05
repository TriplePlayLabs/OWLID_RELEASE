/**
 * Callback Route
 *
 * Handles returns from external identity providers (SAML, OAuth, webhooks).
 * Reads the session ID from query params, resumes the session, issues credential
 * with WebAuthn, and redirects to passport.
 *
 * For webhook_async providers (like Didit), the webhook might not have been
 * processed yet when the user returns, so we poll for a bit.
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import React, { useEffect, useState, useRef } from 'react'
import { Loader2, CheckCircle, XCircle, AlertCircle, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { useIdpVerification } from '../../hooks/use-idp-verification'
import { useCompleteVerificationAfterCallback } from '../../hooks/use-idp-api'
import { useIdentity } from '../../hooks/use-identity'
import { Card, CardContent } from '@owlid/ui/components/ui/card'
import { Button } from '@owlid/ui/components/ui/button'
import Owl from '~/components/Owl'

const INITIAL_POLL_INTERVAL = 2000 // Start with 2 seconds
const MAX_POLL_INTERVAL = 30000 // Max 30 seconds between polls
const MAX_POLL_ATTEMPTS = 60 // Max attempts before giving up

// Layout component - defined outside to prevent recreation on every render
function CallbackLayout({
  children,
  showOwl = true,
}: {
  children: React.ReactNode
  showOwl?: boolean
}) {
  return (
    <div className="w-full flex flex-col items-center justify-center py-8 px-4 animate-in fade-in duration-500">
      {showOwl && (
        <div className="mb-8 flex flex-col items-center">
          <Owl />
          <h1 className="text-2xl md:text-3xl font-bold tracking-tighter uppercase mt-2">Owl ID</h1>
        </div>
      )}
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">{children}</CardContent>
      </Card>
    </div>
  )
}

export const Route = createFileRoute('/_identity/callback')({
  validateSearch: (search: Record<string, unknown>) => ({
    session: (search.session as string) || '',
    error: (search.error as string) || undefined,
  }),
  component: CallbackPage,
})

function CallbackPage() {
  const navigate = useNavigate()
  const { session: sessionFromUrl, error: errorParam } = Route.useSearch()
  const { status, claims, error, flowType, resumeSession, checkStatus, providerStatus, warnings } =
    useIdpVerification()
  const completeVerification = useCompleteVerificationAfterCallback()
  const { setIdentityData, completeIdentityCreation } = useIdentity()
  const [isResuming, setIsResuming] = useState(false)
  const [isIssuingCredential, setIsIssuingCredential] = useState(false)
  const pollCountRef = useRef(0)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const currentDelayRef = useRef(INITIAL_POLL_INTERVAL)
  const consecutiveErrorsRef = useRef(0)

  // Store session ID + bearer token in refs so they survive URL cleanup and
  // sessionStorage drains by use-idp-verification's auto-resume effect.
  const sessionRef = useRef<string>(sessionFromUrl || '')
  if (sessionFromUrl && !sessionRef.current) {
    sessionRef.current = sessionFromUrl
  }
  const session = sessionRef.current || sessionFromUrl

  const sessionTokenRef = useRef<string>('')
  if (!sessionTokenRef.current) {
    sessionTokenRef.current = sessionStorage.getItem('owl_pending_session_token') ?? ''
  }
  const sessionToken = sessionTokenRef.current

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearTimeout(pollIntervalRef.current)
      }
    }
  }, [])

  useEffect(() => {
    // Handle error from provider
    if (errorParam) {
      return
    }

    // Resume session if we have a session ID + token from the redirect
    if (session && sessionToken && !isResuming && status === 'idle') {
      setIsResuming(true)
      resumeSession(session, sessionToken)
    }
  }, [session, sessionToken, errorParam, isResuming, status, resumeSession])

  // For webhook_async providers, poll with exponential backoff
  // (webhook might not have been processed yet)
  useEffect(() => {
    const scheduleNextPoll = () => {
      if (pollCountRef.current >= MAX_POLL_ATTEMPTS) {
        return
      }

      pollIntervalRef.current = setTimeout(async () => {
        pollCountRef.current++
        try {
          await checkStatus()
          consecutiveErrorsRef.current = 0
        } catch (err) {
          console.error('Polling error:', err)
          consecutiveErrorsRef.current++
          if (consecutiveErrorsRef.current >= 3) {
            console.error('Polling stopped after 3 consecutive failures')
            if (pollIntervalRef.current) {
              clearTimeout(pollIntervalRef.current)
              pollIntervalRef.current = null
            }
            return
          }
        }

        // Exponential backoff: increase the delay each time, up to max
        currentDelayRef.current = Math.min(currentDelayRef.current * 1.5, MAX_POLL_INTERVAL)

        // Schedule next poll if still pending
        if (pollCountRef.current < MAX_POLL_ATTEMPTS) {
          scheduleNextPoll()
        }
      }, currentDelayRef.current)
    }

    if (
      status === 'pending' &&
      flowType === 'webhook_async' &&
      !pollIntervalRef.current &&
      pollCountRef.current < MAX_POLL_ATTEMPTS
    ) {
      scheduleNextPoll()
    }

    // Stop polling when verified or failed
    if (status === 'verified' || status === 'failed' || status === 'expired') {
      if (pollIntervalRef.current) {
        clearTimeout(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [status, flowType, checkStatus])

  // When verification is complete, issue credential with WebAuthn
  useEffect(() => {
    if (
      status === 'verified' &&
      claims &&
      !isIssuingCredential &&
      !completeVerification.isSuccess
    ) {
      setIsIssuingCredential(true)

      completeVerification
        .mutateAsync({ sessionId: session })
        .then((credentialData) => {
          // Convert claims to IdentityData format
          const claimsData = credentialData.verifiedClaims
          const identityFromClaims = {
            firstName: claimsData.firstName || '',
            lastName: claimsData.lastName || '',
            birthDate: claimsData.dateOfBirth || '',
            birthPlace: String(claimsData.placeOfBirth || ''),
            nationality: claimsData.nationality || '',
            nationalId: String(claimsData.nationalId || ''),
            passportNumber: String(claimsData.passportNumber || claimsData.documentNumber || ''),
            taxId: String(claimsData.taxId || ''),
            creditScore: 750,
            accountNumber: '',
            email: '',
            phone: '',
            address: `${claimsData.streetAddress || ''}, ${claimsData.city || ''}, ${claimsData.postalCode || ''}, ${claimsData.country || ''}`,
            occupation: '',
            employer: '',
            maritalStatus: '',
            portraitImage: claimsData.portraitImage,
          }

          setIdentityData(identityFromClaims)
          completeIdentityCreation(identityFromClaims)

          toast.success('Identity Created', {
            description: 'Your Owl ID has been cryptographically minted and stored.',
          })

          navigate({ to: '/passport' })
        })
        .catch((err) => {
          console.error('Failed to issue credential:', err)
          toast.error('Failed to issue credential', {
            description: err instanceof Error ? err.message : 'Unknown error',
          })
        })
    }
  }, [
    status,
    claims,
    session,
    isIssuingCredential,
    completeVerification,
    setIdentityData,
    completeIdentityCreation,
    navigate,
  ])

  // Error from provider
  if (errorParam) {
    return (
      <CallbackLayout>
        <div className="flex flex-col items-center text-center space-y-4">
          <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
            <XCircle className="h-8 w-8 text-destructive" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold">Verification Failed</h2>
            <p className="text-muted-foreground text-sm">{decodeURIComponent(errorParam)}</p>
          </div>
          <Button onClick={() => navigate({ to: '/create-identity' })} className="mt-4">
            Try Again
          </Button>
        </div>
      </CallbackLayout>
    )
  }

  // No session ID
  if (!session) {
    return (
      <CallbackLayout>
        <div className="flex flex-col items-center text-center space-y-4">
          <div className="w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center">
            <AlertCircle className="h-8 w-8 text-amber-500" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold">Missing Session</h2>
            <p className="text-muted-foreground text-sm">
              No session ID found in the callback URL.
            </p>
          </div>
          <Button onClick={() => navigate({ to: '/create-identity' })} className="mt-4">
            Start New Verification
          </Button>
        </div>
      </CallbackLayout>
    )
  }

  // Error during credential issuance
  if (completeVerification.isError) {
    return (
      <CallbackLayout>
        <div className="flex flex-col items-center text-center space-y-4">
          <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
            <XCircle className="h-8 w-8 text-destructive" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold">Credential Issuance Failed</h2>
            <p className="text-muted-foreground text-sm">{completeVerification.error?.message}</p>
          </div>
          <Button onClick={() => navigate({ to: '/create-identity' })} className="mt-4">
            Try Again
          </Button>
        </div>
      </CallbackLayout>
    )
  }

  // Error during resume
  if (error) {
    return (
      <CallbackLayout>
        <div className="flex flex-col items-center text-center space-y-4">
          <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
            <XCircle className="h-8 w-8 text-destructive" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold">Verification Error</h2>
            <p className="text-muted-foreground text-sm">{error}</p>
          </div>
          <Button onClick={() => navigate({ to: '/create-identity' })} className="mt-4">
            Try Again
          </Button>
        </div>
      </CallbackLayout>
    )
  }

  // Credential issued successfully
  if (completeVerification.isSuccess) {
    return (
      <CallbackLayout>
        <div className="flex flex-col items-center text-center space-y-4">
          <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center animate-in zoom-in duration-300">
            <CheckCircle className="h-8 w-8 text-green-500" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold">Identity Created!</h2>
            <p className="text-muted-foreground text-sm">Your Owl ID has been minted.</p>
          </div>
          <p className="text-xs text-muted-foreground animate-pulse">
            Redirecting to your passport...
          </p>
        </div>
      </CallbackLayout>
    )
  }

  // Issuing credential with WebAuthn
  if (status === 'verified' && isIssuingCredential) {
    return (
      <CallbackLayout>
        <div className="flex flex-col items-center text-center space-y-4">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
            <ShieldCheck className="h-8 w-8 text-primary animate-pulse" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold">Issuing Credential</h2>
            <p className="text-muted-foreground text-sm">Please authenticate with your passkey.</p>
          </div>
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </CallbackLayout>
    )
  }

  // Loading/Processing state
  const isInReview = providerStatus === 'In Review'

  return (
    <CallbackLayout>
      <div className="flex flex-col items-center text-center space-y-4">
        <div
          className={`w-16 h-16 rounded-full flex items-center justify-center ${isInReview ? 'bg-amber-500/10' : 'bg-primary/10'}`}
        >
          {isInReview ? (
            <AlertCircle className="h-8 w-8 text-amber-500" />
          ) : (
            <Loader2 className="h-8 w-8 text-primary animate-spin" />
          )}
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">
            {isInReview
              ? 'Manual Review Required'
              : status === 'verifying'
                ? 'Verifying Identity'
                : 'Processing'}
          </h2>
          <p className="text-muted-foreground text-sm">
            {isInReview
              ? 'Your verification requires manual review. This may take some time.'
              : 'Please wait while we verify your identity.'}
          </p>
        </div>

        {/* Show warnings if any */}
        {warnings.length > 0 && (
          <div className="w-full space-y-2 mt-2">
            <p className="text-xs text-muted-foreground font-medium">Review reasons:</p>
            <div className="space-y-1">
              {warnings.map((warning, idx) => (
                <div
                  key={idx}
                  className="text-xs text-left p-2 rounded bg-amber-500/5 border border-amber-500/20"
                >
                  <span className="font-medium text-amber-600">
                    {typeof warning === 'string' ? warning : (warning as any).shortDescription}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {flowType === 'webhook_async' && status === 'pending' && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-2">
            <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            <span>{isInReview ? 'Waiting for review completion...' : 'Checking status...'}</span>
          </div>
        )}
      </div>
    </CallbackLayout>
  )
}
