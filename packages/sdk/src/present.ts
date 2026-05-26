/**
 * Holder helpers — low-level primitives shared by the wallet and the
 * verifier SDK.
 *
 * `presentSdJwtVc()` is the per-credential primitive: parse an SD-JWT
 * VC, disclose a subset of claims, append a standard EdDSA KB-JWT
 * bound to a verifier nonce + audience. Multi-credential composition
 * lives in {@link OwlWallet} which calls this once per chosen
 * credential and assembles a DCQL `vp_token`.
 *
 * `respondToPresentation()` is the one-shot "scan + answer" helper for
 * thin holder apps: scan an `OWLP:` engagement QR, connect over
 * WebSocket, await a DCQL request, solve it with the wallet, send the
 * `vp_token` map back. The caller passes a constructed {@link OwlWallet}
 * so per-credential keys are unwrapped through the host's passkey
 * ceremony, not anything this module knows.
 */
import { SdJwtVc } from './sd-jwt.js'
import { resolveWsUrl } from '@owlid/config'
import { decodeSessionEngagement, isPresentationEngagement } from './presentation.js'
import type { PresentationRequest, PresentationResponse, WsMessage } from './presentation.js'
import type { OwlWallet } from './wallet.js'

/** Configuration for {@link respondToPresentation}. */
export interface RespondOptions {
  /** Wallet that solves the verifier's DCQL query + signs the KB-JWTs. */
  wallet: OwlWallet
  /** Approve / deny prompt. Return `false` to send `consent_denied`. */
  onConsent?: (request: PresentationRequest) => boolean | Promise<boolean>
  /** Optional override: pick a specific credentialId for a given DCQL id. */
  overrides?: Record<string, string>
  /** Abort after this many milliseconds. Defaults to 90 s. */
  timeoutMs?: number
}

/**
 * Disclose a subset of an SD-JWT VC and bind it to the verifier with
 * a standard EdDSA KB-JWT (`aud` / `nonce` / `sd_hash`). Per-credential
 * primitive — multi-credential `vp_token` assembly lives in
 * {@link OwlWallet.present}.
 */
export function presentSdJwtVc(
  sdJwtVc: string,
  holderKeyHex: string,
  disclose: string[],
  binding: { aud: string; nonce: string; iat?: number },
): string {
  return SdJwtVc.parse(sdJwtVc).present(disclose, {
    holderPrivateKeyHex: holderKeyHex,
    aud: binding.aud,
    nonce: binding.nonce,
    iat: binding.iat ?? Math.floor(Date.now() / 1000),
  })
}

/** One-shot scan-and-respond helper for holder apps. */
export async function respondToPresentation(
  qrPayload: string,
  options: RespondOptions,
): Promise<void> {
  if (typeof WebSocket === 'undefined') {
    throw new Error('respondToPresentation needs a global WebSocket (browser or polyfill).')
  }
  if (!isPresentationEngagement(qrPayload)) {
    throw new Error('QR payload is not a valid presentation engagement')
  }
  const engagement = decodeSessionEngagement(qrPayload)
  if (!engagement?.ws) {
    throw new Error('Engagement is missing a WebSocket transport')
  }

  const wsUrl = `${resolveWsUrl(engagement.ws.url)}?role=holder`
  const ws = new WebSocket(wsUrl)
  const timeoutMs = options.timeoutMs ?? 90_000

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error(`Presentation timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      try {
        ws.close()
      } catch {
        // ignore
      }
    }

    ws.onerror = () => {
      cleanup()
      reject(new Error('Presentation WebSocket error'))
    }
    ws.onmessage = async (event) => {
      let msg: WsMessage
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
      } catch {
        return
      }
      if (msg.type !== 'request') return

      const request = msg.payload as PresentationRequest
      const approved = options.onConsent ? await options.onConsent(request) : true
      if (!approved) {
        ws.send(JSON.stringify({ type: 'consent_denied', payload: null } satisfies WsMessage))
        cleanup()
        resolve()
        return
      }

      try {
        const { vpToken, used } = await options.wallet.present({
          dcql: request.dcql,
          aud: request.verifierName,
          nonce: request.nonce,
          verifierId: request.verifierId,
          overrides: options.overrides,
        })
        const response: PresentationResponse = {
          sessionId: request.sessionId,
          vpToken,
          used,
        }
        ws.send(JSON.stringify({ type: 'response', payload: response } satisfies WsMessage))
        cleanup()
        resolve()
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: 'proof_failed',
            payload: { code: 'proof_failed' },
          } satisfies WsMessage),
        )
        cleanup()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
  })
}
