import { useState, useCallback, useEffect, useRef } from 'react'
import { ScanLine, ClipboardPaste, Shield, Loader2, Wifi, WifiOff } from 'lucide-react'
import { toast } from 'sonner'
import { QrScanner } from './components/QrScanner'
import { PasteInput } from './components/PasteInput'
import { PredicateSelector } from './components/PredicateSelector'
import { VerificationResult } from './components/VerificationResult'
import { VerificationHistory } from './components/VerificationHistory'
import { verifyToken, healthCheck, type VerifyResult } from './api'
import {
  decodeSessionEngagement,
  isPresentationEngagement,
  isCompactToken,
  type SessionEngagement,
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
  // Legacy steps
  | 'legacy-challenge'
  | 'legacy-scan'
  | 'legacy-paste'

export interface HistoryEntry {
  id: string
  timestamp: Date
  token: string
  challenge: string
  result: VerifyResult
}

const VERIFICATION_URL = import.meta.env.VITE_VERIFICATION_URL || 'http://localhost:8000'

/** Convert an HTTP(S) URL to WS(S) */
function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws')
}

export function App() {
  const [step, setStep] = useState<Step>('idle')
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [serviceOnline, setServiceOnline] = useState<boolean | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const [engagement, setEngagement] = useState<SessionEngagement | null>(null)

  const wsRef = useRef<WebSocket | null>(null)

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

      // Build WebSocket URL: engagement has a relative path, prepend base
      const wsBase = toWsUrl(VERIFICATION_URL)
      const fullUrl = `${wsBase}${eng.ws.url}`

      const ws = new WebSocket(fullUrl)
      wsRef.current = ws

      ws.onopen = () => {
        // Send join message identifying ourselves as the verifier
        const joinMsg: WsMessage = {
          type: 'session_ready',
          payload: null,
        }
        ws.send(JSON.stringify(joinMsg))
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
        toast.error('WebSocket connection error')
        setStep('idle')
        setEngagement(null)
        closeWs()
      }

      ws.onclose = (event) => {
        // Only show error if we didn't intentionally close
        if (step !== 'idle' && step !== 'result' && event.code !== 1000) {
          toast.error('Connection lost', {
            description: 'The session was disconnected. Please try again.',
          })
          setStep('idle')
          setEngagement(null)
        }
      }
    },
    [closeWs, step],
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
            toast.error('Received empty response from holder')
            setStep('idle')
            closeWs()
            return
          }
          handleVerifyPresentation(response.compactToken, eng.nonce)
          break
        }

        case 'consent_denied': {
          const err = msg.payload as WsError | null
          toast.error('Holder declined', {
            description: err?.message || 'The holder did not approve the verification request.',
          })
          setStep('idle')
          setEngagement(null)
          closeWs()
          break
        }

        case 'error': {
          const wsErr = msg.payload as WsError
          toast.error('Session error', { description: wsErr?.message || 'Unknown error' })
          setStep('idle')
          setEngagement(null)
          closeWs()
          break
        }

        default:
          break
      }
    },
    [closeWs],
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
      setStep('verifying')
      setStatusMessage('Verifying proof...')

      try {
        const verifyResult = await verifyToken(compactToken, nonce)
        setResult(verifyResult)
        setStep('result')
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
        setStep('result')
        toast.error('Verification error', { description: message })
      } finally {
        closeWs()
      }
    },
    [closeWs],
  )

  // -----------------------------------------------------------------------
  // QR scan handler (dispatches to new or legacy flow)
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
        // Legacy: direct token verify (need a challenge first)
        toast.info('Legacy token detected', {
          description: 'Use "Start Verification" for challenge-based flow, or paste the token.',
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
  // Legacy direct verify (kept for backward compat)
  // -----------------------------------------------------------------------

  const [legacyChallenge, setLegacyChallenge] = useState<string | null>(null)

  const startLegacyVerification = useCallback(async () => {
    try {
      const { getChallenge } = await import('./api')
      const resp = await getChallenge()
      setLegacyChallenge(resp.challenge)
      setStep('legacy-challenge')
      setResult(null)
    } catch {
      toast.error('Failed to get challenge from server')
    }
  }, [])

  const handleLegacyVerify = useCallback(
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
      if (!legacyChallenge) {
        toast.error('No challenge -- start a new verification')
        return
      }

      setStep('verifying')
      setStatusMessage('Verifying token...')
      try {
        const verifyResult = await verifyToken(trimmed, legacyChallenge)
        setResult(verifyResult)
        setStep('result')
        addToHistory(trimmed, legacyChallenge, verifyResult)

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
        setLegacyChallenge(null)
      }
    },
    [legacyChallenge],
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
    setLegacyChallenge(null)
    setStatusMessage('')
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
      {/* Header */}
      <header className="border-b border-white/10 px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="w-6 h-6 text-blue-400" />
            <h1 className="text-lg font-semibold">OwlID Verifier</h1>
          </div>
          <div className="flex items-center gap-2">
            {serviceOnline === null ? (
              <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />
            ) : serviceOnline ? (
              <Wifi className="w-4 h-4 text-green-400" />
            ) : (
              <WifiOff className="w-4 h-4 text-red-400" />
            )}
            <span className="text-xs text-zinc-500">
              {serviceOnline === null ? 'Connecting...' : serviceOnline ? 'Online' : 'Offline'}
            </span>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 px-4 py-6">
        <div className="max-w-lg mx-auto space-y-6">
          {/* Result */}
          {step === 'result' && result && (
            <VerificationResult result={result} onReset={handleReset} />
          )}

          {/* Idle: main actions */}
          {step === 'idle' && !result && (
            <div className="space-y-4">
              <div className="text-center space-y-2 py-4">
                <Shield className="w-12 h-12 mx-auto text-zinc-600" />
                <h2 className="text-xl font-semibold">Verify a Credential</h2>
                <p className="text-sm text-zinc-400">
                  Scan the holder's QR code to start a verification session
                </p>
              </div>

              {/* Primary: scan presentation QR */}
              <button
                onClick={() => setStep('scanning')}
                disabled={!serviceOnline}
                className="w-full flex items-center justify-center gap-3 p-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ScanLine className="w-5 h-5" />
                Scan Credential
              </button>

              {/* Secondary: legacy challenge-based flow */}
              <button
                onClick={startLegacyVerification}
                disabled={!serviceOnline}
                className="w-full flex items-center justify-center gap-2 p-3 rounded-xl border border-white/10 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ClipboardPaste className="w-4 h-4" />
                Legacy: Challenge + Paste
              </button>

              {!serviceOnline && serviceOnline !== null && (
                <p className="text-center text-xs text-red-400">Verification service is offline.</p>
              )}
            </div>
          )}

          {/* Scanning: QR scanner */}
          {step === 'scanning' && (
            <QrScanner onScan={handleQrScan} onCancel={() => setStep('idle')} />
          )}

          {/* Connecting: loading state */}
          {step === 'connecting' && (
            <div className="flex flex-col items-center justify-center py-12 space-y-4">
              <Loader2 className="w-10 h-10 animate-spin text-blue-400" />
              <p className="text-zinc-400">{statusMessage || 'Connecting...'}</p>
              <button
                onClick={handleReset}
                className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          )}

          {/* Selecting: pick predicates */}
          {step === 'selecting' && (
            <PredicateSelector onSubmit={handleSendRequest} onCancel={handleCancelSelecting} />
          )}

          {/* Waiting: holder approval */}
          {step === 'waiting' && (
            <div className="flex flex-col items-center justify-center py-12 space-y-4">
              <Loader2 className="w-10 h-10 animate-spin text-blue-400" />
              <p className="text-zinc-400">{statusMessage || 'Waiting for holder approval...'}</p>
              <p className="text-xs text-zinc-600">
                The holder is reviewing your request on their device
              </p>
              <button
                onClick={handleReset}
                className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          )}

          {/* Verifying: server check */}
          {step === 'verifying' && (
            <div className="flex flex-col items-center justify-center py-12 space-y-4">
              <Loader2 className="w-10 h-10 animate-spin text-blue-400" />
              <p className="text-zinc-400">{statusMessage || 'Verifying proof...'}</p>
            </div>
          )}

          {/* ============================================================= */}
          {/* Legacy flow steps                                              */}
          {/* ============================================================= */}

          {step === 'legacy-challenge' && legacyChallenge && (
            <div className="space-y-4">
              <div className="text-center space-y-2">
                <h3 className="font-semibold">Legacy: Challenge-Based Verification</h3>
                <p className="text-sm text-zinc-400">
                  Show this challenge to the holder, then scan or paste their token.
                </p>
              </div>

              <div className="p-3 rounded-lg bg-zinc-900 border border-white/10">
                <p className="text-xs text-zinc-500 mb-1">Challenge (5 min expiry)</p>
                <p className="text-xs font-mono text-zinc-400 break-all select-all">
                  {legacyChallenge}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => setStep('legacy-scan')}
                  className="flex flex-col items-center gap-3 p-4 rounded-xl border border-white/10 bg-zinc-900 hover:bg-zinc-800 hover:border-blue-500/30 transition-all"
                >
                  <ScanLine className="w-6 h-6 text-blue-400" />
                  <span className="text-sm font-medium">Scan QR</span>
                </button>
                <button
                  onClick={() => setStep('legacy-paste')}
                  className="flex flex-col items-center gap-3 p-4 rounded-xl border border-white/10 bg-zinc-900 hover:bg-zinc-800 hover:border-blue-500/30 transition-all"
                >
                  <ClipboardPaste className="w-6 h-6 text-blue-400" />
                  <span className="text-sm font-medium">Paste Token</span>
                </button>
              </div>

              <button
                onClick={handleReset}
                className="w-full text-center text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          )}

          {step === 'legacy-scan' && (
            <QrScanner onScan={handleLegacyVerify} onCancel={() => setStep('legacy-challenge')} />
          )}

          {step === 'legacy-paste' && (
            <PasteInput
              onSubmit={handleLegacyVerify}
              onCancel={() => setStep('legacy-challenge')}
            />
          )}

          {/* History */}
          {history.length > 0 && step === 'idle' && !result && (
            <VerificationHistory history={history} onClear={() => setHistory([])} />
          )}
        </div>
      </main>

      <footer className="border-t border-white/10 px-4 py-3">
        <p className="text-center text-xs text-zinc-600">
          OwlID Verifier - Privacy-preserving credential verification
        </p>
      </footer>
    </div>
  )
}
