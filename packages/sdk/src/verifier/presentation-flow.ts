/**
 * `OwlVerifier.requestPresentation` body — drives the WebSocket round
 * with the holder: open session → send DCQL request on `session_ready`
 * → await response → verify the returned `vp_token`. Kept separate so
 * the main `OwlVerifier` class stays readable.
 */
import type { DcqlRequest, VerifyDcqlResponse } from '@owlid/verifier-client'

import type { PresentationRequestOptions, PresentationSession } from './types.js'

/** Verify hook the flow calls once the holder's vp_token arrives.
 *  `vpToken` is OID4VP 1.0 §8.1 shape — keys are DCQL credential
 *  ids, values are always arrays of SD-JWT VC presentations. */
export type VerifyDcqlFn = (
  vpToken: Record<string, string[]>,
  challenge: string,
  audience?: string,
  query?: DcqlRequest,
  verifierId?: string,
) => Promise<VerifyDcqlResponse>

const DEFAULT_TIMEOUT_MS = 90_000

const failResult = (error: string): VerifyDcqlResponse => ({
  valid: false,
  perCredential: {},
  subjects: {},
  error,
})

/**
 * Drive the full presentation flow over the verifier-side WebSocket
 * opened against `session.verifierWsUrl`. Resolves to the
 * `VerifyDcqlResponse` returned by `verifyDcql`, or to a synthetic
 * failure when the holder denies consent / reports a proof failure /
 * the session times out.
 */
export async function runPresentationFlow(
  session: PresentationSession,
  options: PresentationRequestOptions,
  verifyDcql: VerifyDcqlFn,
): Promise<VerifyDcqlResponse> {
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      'requestPresentation needs a global WebSocket. ' +
        'Use openPresentation() and a Node ws client for server flows.',
    )
  }

  options.onQr?.(session.qrPayload)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const ws = new WebSocket(session.verifierWsUrl)

  const requestPayload = {
    sessionId: session.sessionId,
    verifierName: options.verifierName,
    verifierId: options.verifierId,
    dcql: options.dcql,
    nonce: session.nonce,
    timestamp: Date.now(),
  }

  return new Promise<VerifyDcqlResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error(`Presentation timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
      try {
        ws.close()
      } catch {
        /* socket already closed */
      }
    }

    ws.onopen = () => {
      // Server sends `session_ready` first; request is sent then.
    }
    ws.onerror = () => {
      cleanup()
      reject(new Error('Presentation WebSocket error'))
    }
    ws.onclose = () => clearTimeout(timeout)
    ws.onmessage = async (event) => {
      let msg: { type?: string; payload?: unknown }
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
      } catch {
        return
      }
      switch (msg.type) {
        case 'session_ready':
          ws.send(JSON.stringify({ type: 'request', payload: requestPayload }))
          break
        case 'response': {
          const payload = (msg.payload ?? {}) as { vpToken?: Record<string, string[]> }
          const vpToken = payload.vpToken ?? {}
          cleanup()
          try {
            resolve(
              await verifyDcql(
                vpToken,
                session.nonce,
                options.verifierName,
                options.dcql,
                options.verifierId,
              ),
            )
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)))
          }
          break
        }
        case 'consent_denied':
          cleanup()
          resolve(failResult('Holder denied consent'))
          break
        case 'proof_failed':
          cleanup()
          resolve(failResult('Holder reported proof failure'))
          break
        case 'error': {
          const payload = (msg.payload ?? {}) as { message?: string }
          cleanup()
          resolve(failResult(payload.message ?? 'Presentation error'))
          break
        }
      }
    }
  })
}
