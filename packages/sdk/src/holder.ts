/**
 * OwlHolder — high-level wallet helpers.
 *
 * Single-call helpers for the most common holder-app flows: respond to a
 * verifier's QR, sign a token with a WebAuthn passkey, etc. Compose the
 * lower-level primitives (`Credential`, `Token`, `KeyPair`) when you need
 * full control.
 */
import type {
  Credential,
  KeyPair,
  Token,
  ProofRequest,
  WebAuthnSignatureData,
} from '@owlid/native-sdk'
import { Token as NativeToken } from '@owlid/native-sdk'
import { resolveWsUrl } from './config.js'
import { decodeSessionEngagement, isPresentationEngagement } from './presentation.js'
import { circuitsForPredicates, ensureProvingKeysFor } from './proving-keys.js'
import { signChallenge } from './webauthn.js'

/** Owner signing material — either a raw Ed25519 keypair or a WebAuthn passkey. */
export type HolderSigner =
  | { type: 'keypair'; keyPair: KeyPair }
  | { type: 'passkey'; credentialId: string; publicKeyHex: string }

/** Verifier's request shown to the holder for consent. */
export interface PresentationConsentRequest {
  verifierName: string
  requestedPredicates: Array<{ id: string; label: string }>
  requestedDisclosures: string[]
  sessionId: string
  nonce: string
  timestamp: number
}

/** Configuration for `respondToPresentation`. */
export interface RespondOptions {
  /** Holder's signed credential (the `Credential` instance, not raw JSON). */
  credential: Credential
  /** Owner signer — raw key for Ed25519 or passkey identifier for WebAuthn. */
  signer: HolderSigner
  /** Map verifier predicate ids to a {@link ProofRequest} clause. */
  buildProofRequest: (consent: PresentationConsentRequest) => ProofRequest
  /** Approve / deny prompt. Return `false` to send `consent_denied`. */
  onConsent?: (consent: PresentationConsentRequest) => boolean | Promise<boolean>
  /** Token TTL in seconds. Defaults to 300. */
  ttlSeconds?: number
  /** Abort after this many milliseconds. Defaults to 90 s. */
  timeoutMs?: number
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
      let msg: { type?: string; payload?: unknown }
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
      } catch {
        return
      }
      if (msg.type !== 'request') return

      const consent = msg.payload as PresentationConsentRequest
      const approved = options.onConsent ? await options.onConsent(consent) : true
      if (!approved) {
        ws.send(JSON.stringify({ type: 'consent_denied', payload: null }))
        cleanup()
        resolve()
        return
      }

      try {
        const request = options.buildProofRequest(consent)
        const token = await signToken({
          credential: options.credential,
          request,
          ttlSeconds: options.ttlSeconds ?? 300,
          signer: options.signer,
        })
        ws.send(
          JSON.stringify({
            type: 'response',
            payload: { sessionId: consent.sessionId, compactToken: token.toCompact() },
          }),
        )
        cleanup()
        resolve()
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: 'error',
            payload: {
              code: 'proof_failed',
              message: err instanceof Error ? err.message : String(err),
            },
          }),
        )
        cleanup()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
  })
}

/** Options for {@link signToken}. */
export interface SignTokenOptions {
  credential: Credential
  request: ProofRequest
  ttlSeconds: number
  signer: HolderSigner
}

/**
 * Build a token, dispatching on signer type.
 *
 *  - `keypair`: one-phase Ed25519 (`Credential.prove`)
 *  - `passkey`: two-phase WebAuthn (`Credential.prepare` → enclave → `Token.finalizeWebauthn`)
 *
 * On WASM builds the Groth16 proving keys for the request's predicates
 * are loaded transparently (cached per-device) before either path runs.
 * Native builds skip the load (keys are embedded).
 */
export async function signToken(options: SignTokenOptions): Promise<Token> {
  const { credential, request, ttlSeconds, signer } = options
  await ensureProvingKeysFor(circuitsForPredicates(request.predicates))
  if (signer.type === 'keypair') {
    return credential.prove(request, signer.keyPair, ttlSeconds)
  }
  return signTokenWithPasskey({ credential, request, ttlSeconds, passkey: signer })
}

/** Options for {@link signTokenWithPasskey}. */
export interface SignTokenWithPasskeyOptions {
  credential: Credential
  request: ProofRequest
  ttlSeconds: number
  passkey: { credentialId: string; publicKeyHex: string }
}

/**
 * Sign a token with a WebAuthn passkey in one call.
 *
 * Combines `Credential.prepare` + `signChallenge` + `Token.finalizeWebauthn`.
 * Triggers the platform's biometric / PIN prompt. Loads the proving keys
 * the request's predicates need (WASM builds only) before preparing.
 */
export async function signTokenWithPasskey(options: SignTokenWithPasskeyOptions): Promise<Token> {
  await ensureProvingKeysFor(circuitsForPredicates(options.request.predicates))
  const prepared = options.credential.prepare(options.request, options.ttlSeconds)
  const signed = await signChallenge(options.passkey.credentialId, prepared.challenge())
  const sigData: WebAuthnSignatureData = {
    authenticatorData: signed.authenticatorData,
    clientDataJson: signed.clientDataJSON,
    signature: signed.signature,
  }
  return NativeToken.finalizeWebauthn(prepared, sigData, options.passkey.publicKeyHex)
}
