import { useState, useCallback, useEffect, useRef } from 'react'
import { ScanLine, ClipboardPaste, Shield, Loader2, Wifi, WifiOff, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { QRCodeSVG } from 'qrcode.react'
import { QrScanner } from './components/QrScanner'
import { PasteInput } from './components/PasteInput'
import { PredicateSelector } from './components/PredicateSelector'
import { VerificationResult } from './components/VerificationResult'
import { VerificationHistory } from './components/VerificationHistory'
import { verifyToken, healthCheck, type VerifyResult } from './api'
import { Badge } from '@owlid/ui/components/ui/badge'
import { Button } from '@owlid/ui/components/ui/button'
import { Card, CardContent } from '@owlid/ui/components/ui/card'
import {
  decodeSessionEngagement,
  isPresentationEngagement,
  isCompactToken,
  type SessionEngagement,
  type PredicateNotSatisfiedPayload,
  type PresentationPredicate,
  type PresentationRequest,
  type PresentationResponse,
  type WsMessage,
  type WsError,
} from '@owlid/sdk'

/**
 * Verification flow:
 *
 * NEW (presentation protocol):
 *   idle -> scanning -> connecting -> selecting -> waiting -> verifying -> result
 *   Holder shows OWLP: QR -> verifier scans, connects WS, picks predicates,
 *   holder approves, verifier receives token and verifies.
 *
 * LEGACY (direct verify):
 *   idle -> scanning|paste -> verifying -> result
 *   Holder shows OID1: token QR -> verifier scans/pastes and verifies directly.
 */

type Step =
  | 'idle'
  | 'scanning'
  | 'connecting'
  | 'selecting'
  | 'waiting'
  | 'verifying'
  | 'result'
  | 'error'
  // Manual steps (challenge-based, no live session)
  | 'manual-challenge'
  | 'manual-scan'
  | 'manual-paste'

export interface HistoryEntry {
  id: string
  timestamp: Date
  token: string
  challenge: string
  result: VerifyResult
}

import { resolveWsUrl } from '@owlid/sdk'

/**
 * Map an attribute name (which the verifier already asked about) to a
 * sanitized reason string. The holder's actual value is NEVER reflected back
 * — the whole point of the ZK protocol is that the verifier learns only
 * pass / fail, not the underlying witness.
 */
function predicateFailureReason(attribute: string | undefined): string {
  switch (attribute) {
    case 'dateOfBirth':
      return 'Holder does not meet the age requirement.'
    case 'nationality':
      return 'Holder nationality is not in the accepted set.'
    case 'verificationLevel':
      return 'Holder KYC level is below the required level.'
    case 'isResident':
      return 'Holder is not a verified resident.'
    default:
      return 'Holder does not satisfy the requested predicate.'
  }
}

export function App() {
  const [step, setStep] = useState<Step>('idle')
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [serviceOnline, setServiceOnline] = useState<boolean | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const [engagement, setEngagement] = useState<SessionEngagement | null>(null)
  const [errorMessage, setErrorMessage] = useState<string>('')

  const wsRef = useRef<WebSocket | null>(null)
  // Mirror of `step` for use inside async callbacks where the closure would
  // otherwise see a stale value. Updated SYNCHRONOUSLY by `transitionStep`
  // so a ws message that fires between `setStep` and React's commit phase
  // can still observe the latest intent.
  const stepRef = useRef<Step>('idle')
  const transitionStep = useCallback((s: Step) => {
    stepRef.current = s
    setStep(s)
  }, [])

  // Centralized error transition. Skips work when we're already in a
  // post-flow state ('verifying', 'result', 'error') so a late ws.onclose
  // doesn't blow away the result the user is reading.
  const goToError = useCallback(
    (message: string) => {
      const cur = stepRef.current
      if (cur === 'verifying' || cur === 'result' || cur === 'error') return
      setErrorMessage(message)
      transitionStep('error')
      setEngagement(null)
    },
    [transitionStep],
  )

  // Health check polling
  useEffect(() => {
    healthCheck().then(setServiceOnline)
    const interval = setInterval(() => healthCheck().then(setServiceOnline), 30000)
    return () => clearInterval(interval)
  }, [])

  // Clean up WebSocket on unmount or step reset
  useEffect(() => {
    return () => {
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [])

  const closeWs = useCallback(() => {
    wsRef.current?.close()
    wsRef.current = null
  }, [])

  // -----------------------------------------------------------------------
  // Presentation protocol (OWLP:)
  // -----------------------------------------------------------------------

  const connectToSession = useCallback(
    (eng: SessionEngagement) => {
      if (!eng.ws) {
        toast.error('No WebSocket transport in engagement')
        setStep('idle')
        return
      }

      setEngagement(eng)
      setStep('connecting')
      setStatusMessage('Connecting to session...')

      // resolveWsUrl handles both relative path (preferred — split deployments)
      // and pre-absolute ws:// / wss:// URLs from older holders. Append the
      // verifier role so the backend's WsSessionQuery accepts the upgrade.
      const baseUrl = resolveWsUrl(eng.ws.url)
      const fullUrl = baseUrl.includes('?')
        ? `${baseUrl}&role=verifier`
        : `${baseUrl}?role=verifier`
      const ws = new WebSocket(fullUrl)
      wsRef.current = ws

      ws.onopen = () => {
        // Don't send anything yet — the server will broadcast `session_ready`
        // to BOTH parties as soon as the holder also connects. The presentation
        // protocol restricts the verifier to sending only `request`, so any
        // pre-pairing send gets
        // rejected as `invalid_message` and tears down the session.
        setStep('selecting')
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as WsMessage
          handleWsMessage(msg, eng)
        } catch {
          toast.error('Received malformed message from server')
        }
      }

      ws.onerror = () => {
        goToError('Could not reach the verification service. Check your connection and try again.')
        closeWs()
      }

      ws.onclose = (event) => {
        // Code 1000 = clean close (we initiated). Anything else = peer
        // dropped or transport failure. Only escalate to an error UI if we
        // were still mid-flow.
        if (event.code === 1000) return
        goToError('The session was disconnected before completing.')
      }
    },
    [closeWs, goToError],
  )

  const handleWsMessage = useCallback(
    (msg: WsMessage, eng: SessionEngagement) => {
      switch (msg.type) {
        case 'session_ready':
          // Server confirmed both parties connected; move to selecting if not already
          setStep('selecting')
          break

        case 'response': {
          // Holder sent their proof
          const response = msg.payload as PresentationResponse
          if (!response?.compactToken) {
            goToError('Holder sent an empty response.')
            closeWs()
            return
          }
          // Lock the ref to 'verifying' SYNCHRONOUSLY so a backend
          // 'Peer disconnected' error queued right after the response
          // (holder closes its ws once it's done) can't hijack us into
          // the error state mid-verification.
          stepRef.current = 'verifying'
          handleVerifyPresentation(response.compactToken, eng.nonce)
          break
        }

        case 'consent_denied': {
          const err = msg.payload as WsError | null
          goToError(err?.message || 'The holder declined this verification request.')
          closeWs()
          break
        }

        case 'predicate_not_satisfied': {
          // Privacy: the holder's credential value does not satisfy the
          // requested predicate. This is a normal verification outcome —
          // surface it as `valid: false` with a sanitized reason, NOT as an
          // error UI. The payload only carries the attribute name, which the
          // verifier already asked about; never display free-form text from
          // the holder side.
          const payload = msg.payload as PredicateNotSatisfiedPayload | null
          const reason = predicateFailureReason(payload?.attribute)
          stepRef.current = 'result'
          setResult({ valid: false, error: reason })
          setStep('result')
          addToHistory('(no token — predicate not satisfied)', eng.nonce, {
            valid: false,
            error: reason,
          })
          toast.error('Verification failed', { description: reason })
          closeWs()
          break
        }

        case 'proof_failed': {
          // Holder hit a non-predicate failure. Render generic — never any
          // holder-supplied text.
          stepRef.current = 'result'
          const reason = 'Holder could not generate a valid proof.'
          setResult({ valid: false, error: reason })
          setStep('result')
          addToHistory('(no token — proof failed)', eng.nonce, { valid: false, error: reason })
          toast.error('Verification failed', { description: reason })
          closeWs()
          break
        }

        case 'error': {
          const wsErr = msg.payload as WsError
          // Transport-level only. Do NOT render arbitrary holder strings —
          // `error` from the relay covers things like `Peer disconnected`,
          // not predicate outcomes (those have their own message types).
          goToError(wsErr?.message || 'Session error.')
          break
        }

        default:
          break
      }
    },
    [closeWs, goToError],
  )

  const handleSendRequest = useCallback(
    (predicates: PresentationPredicate[], verifierName: string) => {
      if (!engagement?.ws || !wsRef.current) {
        toast.error('Not connected to session')
        setStep('idle')
        return
      }

      const request: PresentationRequest = {
        sessionId: engagement.ws.sessionId,
        verifierName,
        requestedPredicates: predicates,
        requestedDisclosures: [],
        nonce: engagement.nonce,
        timestamp: Date.now(),
      }

      const msg: WsMessage = {
        type: 'request',
        payload: request,
      }

      wsRef.current.send(JSON.stringify(msg))
      setStep('waiting')
      setStatusMessage('Waiting for holder approval...')
    },
    [engagement],
  )

  const handleVerifyPresentation = useCallback(
    async (compactToken: string, nonce: string) => {
      transitionStep('verifying')
      setStatusMessage('Verifying proof...')

      try {
        const verifyResult = await verifyToken(compactToken, nonce)
        setResult(verifyResult)
        transitionStep('result')
        addToHistory(compactToken, nonce, verifyResult)

        if (verifyResult.valid) {
          toast.success('Proof verified successfully')
        } else {
          toast.error('Verification failed', {
            description: verifyResult.error || 'The proof is invalid',
          })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Verification request failed'
        const failResult: VerifyResult = { valid: false, error: message }
        setResult(failResult)
        transitionStep('result')
        toast.error('Verification error', { description: message })
      } finally {
        closeWs()
      }
    },
    [closeWs, transitionStep],
  )

  // -----------------------------------------------------------------------
  // QR scan handler (dispatches to presentation or manual flow)
  // -----------------------------------------------------------------------

  const handleQrScan = useCallback(
    (data: string) => {
      if (isPresentationEngagement(data)) {
        // New presentation protocol
        const eng = decodeSessionEngagement(data)
        if (!eng) {
          toast.error('Invalid engagement QR code')
          setStep('idle')
          return
        }
        connectToSession(eng)
      } else if (isCompactToken(data)) {
        // Manual flow: direct token verify (need a challenge first)
        toast.info('Token detected (manual flow)', {
          description:
            'Use "Start Verification" for challenge-based flow, or paste the token below.',
        })
        setStep('idle')
      } else {
        toast.error('Unrecognized QR code', {
          description: 'Expected an OwlID presentation or token.',
        })
        setStep('idle')
      }
    },
    [connectToSession],
  )

  // -----------------------------------------------------------------------
  // Manual flow: verifier mints challenge, holder signs it offline
  // -----------------------------------------------------------------------

  const [manualChallenge, setManualChallenge] = useState<string | null>(null)

  const startManualVerification = useCallback(async () => {
    try {
      const { getChallenge } = await import('./api')
      const resp = await getChallenge()
      setManualChallenge(resp.challenge)
      setStep('manual-challenge')
      setResult(null)
    } catch {
      toast.error('Failed to get challenge from server')
    }
  }, [])

  const handleManualVerify = useCallback(
    async (compactToken: string) => {
      const trimmed = compactToken.trim()
      if (!trimmed) {
        toast.error('Empty token')
        return
      }
      if (!trimmed.startsWith('OID1:')) {
        toast.error('Invalid token format', { description: 'OwlID tokens start with "OID1:"' })
        return
      }
      if (!manualChallenge) {
        toast.error('No challenge -- start a new verification')
        return
      }

      setStep('verifying')
      setStatusMessage('Verifying token...')
      try {
        const verifyResult = await verifyToken(trimmed, manualChallenge)
        setResult(verifyResult)
        setStep('result')
        addToHistory(trimmed, manualChallenge, verifyResult)

        if (verifyResult.valid) {
          toast.success('Token verified successfully')
        } else {
          toast.error('Verification failed', {
            description: verifyResult.error || 'Token is invalid',
          })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Verification request failed'
        const failResult: VerifyResult = { valid: false, error: message }
        setResult(failResult)
        setStep('result')
        toast.error('Verification error', { description: message })
      } finally {
        setManualChallenge(null)
      }
    },
    [manualChallenge],
  )

  // -----------------------------------------------------------------------
  // History
  // -----------------------------------------------------------------------

  const addToHistory = (token: string, challenge: string, verifyResult: VerifyResult) => {
    setHistory((prev) =>
      [
        {
          id: crypto.randomUUID(),
          timestamp: new Date(),
          token: token.slice(0, 40) + '...',
          challenge: challenge.slice(0, 16) + '...',
          result: verifyResult,
        },
        ...prev,
      ].slice(0, 50),
    )
  }

  const handleReset = useCallback(() => {
    setResult(null)
    setStep('idle')
    setEngagement(null)
    setManualChallenge(null)
    setStatusMessage('')
    setErrorMessage('')
    closeWs()
  }, [closeWs])

  const handleCancelSelecting = useCallback(() => {
    setStep('idle')
    setEngagement(null)
    closeWs()
  }, [closeWs])

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="min-h-dvh flex flex-col">
      <header className="border-b px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="w-6 h-6 text-blue-400" />
            <h1 className="text-lg font-semibold">OwlID Verifier</h1>
          </div>
          <Badge variant={serviceOnline ? 'default' : 'secondary'} className="gap-1.5">
            {serviceOnline === null ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : serviceOnline ? (
              <Wifi className="w-3 h-3" />
            ) : (
              <WifiOff className="w-3 h-3" />
            )}
            {serviceOnline === null ? 'Connecting...' : serviceOnline ? 'Online' : 'Offline'}
          </Badge>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 flex flex-col items-center justify-center">
        <div className="w-full max-w-lg space-y-6">
          {step === 'result' && result && (
            <VerificationResult result={result} onReset={handleReset} />
          )}

          {step === 'idle' && !result && (
            <Card>
              <CardContent className="space-y-4 py-6">
                <div className="text-center space-y-2 py-2">
                  <Shield className="w-12 h-12 mx-auto text-muted-foreground" />
                  <h2 className="text-xl font-semibold">Verify a Credential</h2>
                  <p className="text-sm text-muted-foreground">
                    Scan the holder's QR code to start a verification session
                  </p>
                </div>

                <Button
                  className="w-full"
                  size="lg"
                  onClick={() => setStep('scanning')}
                  disabled={!serviceOnline}
                >
                  <ScanLine className="w-4 h-4" />
                  Scan Credential
                </Button>

                <Button
                  variant="outline"
                  className="w-full"
                  onClick={startManualVerification}
                  disabled={!serviceOnline}
                >
                  <ClipboardPaste className="w-4 h-4" />
                  Manual: Challenge + Paste
                </Button>

                {!serviceOnline && serviceOnline !== null && (
                  <p className="text-center text-xs text-red-400">
                    Verification service is offline.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {step === 'scanning' && (
            <QrScanner onScan={handleQrScan} onCancel={() => setStep('idle')} />
          )}

          {step === 'connecting' && (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 space-y-4">
                <Loader2 className="w-10 h-10 animate-spin text-blue-400" />
                <p className="text-muted-foreground">{statusMessage || 'Connecting...'}</p>
                <Button variant="ghost" size="sm" onClick={handleReset}>
                  Cancel
                </Button>
              </CardContent>
            </Card>
          )}

          {step === 'selecting' && (
            <PredicateSelector onSubmit={handleSendRequest} onCancel={handleCancelSelecting} />
          )}

          {step === 'waiting' && (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 space-y-4">
                <Loader2 className="w-10 h-10 animate-spin text-blue-400" />
                <p className="text-muted-foreground">
                  {statusMessage || 'Waiting for holder approval...'}
                </p>
                <p className="text-xs text-muted-foreground">
                  The holder is reviewing your request on their device
                </p>
                <Button variant="ghost" size="sm" onClick={handleReset}>
                  Cancel
                </Button>
              </CardContent>
            </Card>
          )}

          {step === 'verifying' && (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 space-y-4">
                <Loader2 className="w-10 h-10 animate-spin text-blue-400" />
                <p className="text-muted-foreground">{statusMessage || 'Verifying proof...'}</p>
              </CardContent>
            </Card>
          )}

          {step === 'error' && (
            <Card className="border-red-500/30 bg-red-500/5">
              <CardContent className="flex flex-col items-center justify-center py-12 space-y-4 text-center">
                <div className="w-14 h-14 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center">
                  <WifiOff className="w-7 h-7 text-red-400" />
                </div>
                <div className="space-y-1 max-w-sm">
                  <h2 className="text-lg font-semibold">Verification interrupted</h2>
                  <p className="text-sm text-muted-foreground">
                    {errorMessage || 'The session ended before completing.'}
                  </p>
                </div>
                <div className="flex gap-3 pt-2">
                  <Button variant="outline" onClick={handleReset}>
                    Back to Home
                  </Button>
                  <Button
                    onClick={() => {
                      handleReset()
                      setStep('scanning')
                    }}
                  >
                    Scan Again
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {step === 'manual-challenge' && manualChallenge && (
            <Card>
              <CardContent className="space-y-4 py-6">
                <div className="text-center space-y-2">
                  <h3 className="font-semibold">Manual: Challenge-Based Verification</h3>
                  <p className="text-sm text-muted-foreground">
                    Have the holder scan this QR (or copy the text) to sign the challenge. Then scan
                    or paste their token.
                  </p>
                </div>

                <div className="bg-white p-4 rounded-xl flex justify-center">
                  <QRCodeSVG value={manualChallenge} size={220} />
                </div>

                <div className="space-y-2 rounded-md border bg-muted/40 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">Challenge (5 min expiry)</p>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-auto px-2 py-1"
                      onClick={() => {
                        navigator.clipboard
                          .writeText(manualChallenge)
                          .then(() => toast.success('Challenge copied'))
                          .catch(() => toast.error('Copy failed'))
                      }}
                      aria-label="Copy challenge"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      Copy
                    </Button>
                  </div>
                  <p className="text-xs font-mono text-muted-foreground break-all select-all">
                    {manualChallenge}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Button
                    variant="outline"
                    className="h-auto flex-col gap-2 py-4"
                    onClick={() => setStep('manual-scan')}
                  >
                    <ScanLine className="w-6 h-6 text-blue-400" />
                    <span className="text-sm font-medium">Scan Token</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-auto flex-col gap-2 py-4"
                    onClick={() => setStep('manual-paste')}
                  >
                    <ClipboardPaste className="w-6 h-6 text-blue-400" />
                    <span className="text-sm font-medium">Paste Token</span>
                  </Button>
                </div>

                <Button variant="ghost" className="w-full" onClick={handleReset}>
                  Cancel
                </Button>
              </CardContent>
            </Card>
          )}

          {step === 'manual-scan' && (
            <QrScanner onScan={handleManualVerify} onCancel={() => setStep('manual-challenge')} />
          )}

          {step === 'manual-paste' && (
            <PasteInput
              onSubmit={handleManualVerify}
              onCancel={() => setStep('manual-challenge')}
            />
          )}

          {history.length > 0 && step === 'idle' && !result && (
            <VerificationHistory history={history} onClear={() => setHistory([])} />
          )}
        </div>
      </main>

      <footer className="border-t px-4 py-3">
        <p className="text-center text-xs text-muted-foreground">
          OwlID Verifier - Privacy-preserving credential verification
        </p>
      </footer>
    </div>
  )
}
