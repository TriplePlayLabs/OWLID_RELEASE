/**
 * WebAuthn React Hook
 *
 * Thin React wrapper around @owlid/sdk WebAuthn functions.
 * Adds logging callbacks for UI feedback.
 */

import { useCallback } from 'react'
import {
  registerCredential,
  signChallenge as sdkSignChallenge,
  base64urlToBuffer,
  type WebAuthnSignatureResult,
  type WebAuthnRegistrationResult,
} from '@owlid/sdk'

// Re-export types for convenience
export type { WebAuthnSignatureResult, WebAuthnRegistrationResult }

interface UseWebAuthnOptions {
  onLog?: (type: 'info' | 'success' | 'error' | 'system', message: string) => void
}

export function useWebAuthn(options: UseWebAuthnOptions = {}) {
  const { onLog } = options

  const log = useCallback(
    (type: 'info' | 'success' | 'error' | 'system', message: string) => {
      onLog?.(type, message)
    },
    [onLog],
  )

  /**
   * Register a new WebAuthn credential
   * Returns the credential ID and COSE public key for use in credential issuance
   */
  const register = useCallback(
    async (username: string): Promise<WebAuthnRegistrationResult | null> => {
      log('system', `Initiating WebAuthn registration for user: ${username}`)
      log('info', 'POST /webauthn/register/options')

      log('system', 'Browser invoking navigator.credentials.create()')
      log('system', 'User prompted for biometric/security key...')

      try {
        const result = await registerCredential({
          rpName: 'Owl ID Demo',
          rpId: window.location.hostname,
          userName: username,
          userDisplayName: username,
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
          attestation: 'none',
        })

        log('success', 'Extracted P-256 public key from secure enclave')
        log('success', 'Authenticator interaction successful')
        log('info', 'Public key extracted for credential issuance')

        return result
      } catch (e) {
        log('error', `Failed to register credential: ${e}`)
        throw e
      }
    },
    [log],
  )

  /**
   * Sign a token challenge using WebAuthn
   * The challenge should be base64url-encoded SHA256 of the token payload
   * Returns the signature data needed for token finalization
   */
  const signForToken = useCallback(
    async (credentialId: string, challenge: string): Promise<WebAuthnSignatureResult> => {
      log('system', 'Initiating WebAuthn signing for token...')
      log('info', 'Challenge bound to token payload')

      log('system', 'Requesting biometric authentication...')

      try {
        const result = await sdkSignChallenge(credentialId, challenge, {
          rpId: window.location.hostname,
          userVerification: 'required',
          transports: ['internal', 'hybrid'],
        })

        log('success', 'Biometric authentication successful')
        log('info', 'Hardware-backed signature created')

        return result
      } catch (e) {
        log('error', `WebAuthn signing failed: ${e}`)
        throw e
      }
    },
    [log],
  )

  /**
   * Authenticate with a WebAuthn credential
   * Returns the full PublicKeyCredential for further processing
   */
  const authenticate = useCallback(
    async (credentialId: string | null): Promise<PublicKeyCredential | null> => {
      log('info', 'POST /webauthn/authenticate/options')

      const challenge = new Uint8Array(32)
      window.crypto.getRandomValues(challenge)

      const publicKeyCredentialRequestOptions: PublicKeyCredentialRequestOptions = {
        challenge: new Uint8Array(challenge).buffer as ArrayBuffer,
        timeout: 60000,
        userVerification: 'preferred',
        rpId: window.location.hostname,
        allowCredentials: credentialId
          ? [
              {
                id: base64urlToBuffer(credentialId),
                type: 'public-key',
                transports: ['internal', 'hybrid'],
              },
            ]
          : undefined,
      }

      log('system', 'Browser invoking navigator.credentials.get()')
      log('system', 'Verifying passkey ownership...')

      const abortController = new AbortController()
      const timeoutId = setTimeout(() => abortController.abort(), 60000)

      let assertion: PublicKeyCredential
      try {
        assertion = (await navigator.credentials.get({
          publicKey: publicKeyCredentialRequestOptions,
          signal: abortController.signal,
        })) as PublicKeyCredential
      } finally {
        clearTimeout(timeoutId)
      }

      if (!assertion) {
        throw new Error('Credential assertion returned null')
      }

      log('success', 'Cryptographic signature valid')
      log('info', 'POST /webauthn/authenticate/verify')

      return assertion
    },
    [log],
  )

  /**
   * Sign a challenge for proof generation
   */
  const signChallenge = useCallback(
    async (credentialId: string | null): Promise<PublicKeyCredential | null> => {
      log('info', 'POST /webauthn/prove/options')
      log('info', 'Challenge generated based on identity data hash')

      const challenge = new Uint8Array(32)
      window.crypto.getRandomValues(challenge)

      const publicKeyCredentialRequestOptions: PublicKeyCredentialRequestOptions = {
        challenge: new Uint8Array(challenge).buffer as ArrayBuffer,
        timeout: 60000,
        userVerification: 'required',
        rpId: window.location.hostname,
        allowCredentials: credentialId
          ? [
              {
                id: base64urlToBuffer(credentialId),
                type: 'public-key',
              },
            ]
          : undefined,
      }

      log('system', 'Browser signing identity data with private key...')

      const abortController = new AbortController()
      const timeoutId = setTimeout(() => abortController.abort(), 60000)

      let assertion: PublicKeyCredential
      try {
        assertion = (await navigator.credentials.get({
          publicKey: publicKeyCredentialRequestOptions,
          signal: abortController.signal,
        })) as PublicKeyCredential
      } finally {
        clearTimeout(timeoutId)
      }

      if (!assertion) {
        throw new Error('Signing returned null')
      }

      return assertion
    },
    [log],
  )

  /**
   * Unlock identity data with passkey
   */
  const unlockWithPasskey = useCallback(
    async (credentialId: string | null): Promise<PublicKeyCredential | null> => {
      log('system', 'Initiating Decryption Sequence...')
      log('info', 'POST /webauthn/authenticate/options')

      const challenge = new Uint8Array(32)
      window.crypto.getRandomValues(challenge)

      const publicKeyCredentialRequestOptions: PublicKeyCredentialRequestOptions = {
        challenge: new Uint8Array(challenge).buffer as ArrayBuffer,
        timeout: 60000,
        userVerification: 'required',
        rpId: window.location.hostname,
        allowCredentials: credentialId
          ? [
              {
                id: base64urlToBuffer(credentialId),
                type: 'public-key',
                transports: ['internal', 'hybrid'],
              },
            ]
          : undefined,
      }

      log('system', 'Requesting Private Key Access to Decrypt Data...')

      const abortController = new AbortController()
      const timeoutId = setTimeout(() => abortController.abort(), 60000)

      let assertion: PublicKeyCredential
      try {
        assertion = (await navigator.credentials.get({
          publicKey: publicKeyCredentialRequestOptions,
          signal: abortController.signal,
        })) as PublicKeyCredential
      } finally {
        clearTimeout(timeoutId)
      }

      if (!assertion) {
        throw new Error('Decryption authorization denied')
      }

      log('success', 'Private Key Access Granted')
      log('info', 'Decrypting Local Identity Blob...')

      return assertion
    },
    [log],
  )

  return {
    register,
    authenticate,
    signChallenge,
    signForToken,
    unlockWithPasskey,
  }
}
