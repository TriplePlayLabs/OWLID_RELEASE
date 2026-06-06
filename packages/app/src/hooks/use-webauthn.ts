/**
 * WebAuthn React Hook
 *
 * Thin React wrapper around @owlid/sdk WebAuthn functions.
 * Adds logging callbacks for UI feedback.
 */

import { useCallback } from 'react'
import { base64urlToBuffer, type WebAuthnRegistrationResult } from '@owlid/sdk'
import { registerWalletPasskey, rememberAssertionPasskey } from '~/lib/passkeys'
import { withPasskeyCeremony } from '~/lib/wallet-session'

// Re-export types for convenience
export type { WebAuthnSignatureResult, WebAuthnRegistrationResult } from '@owlid/sdk'

interface UseWebAuthnOptions {
  onLog?: (type: 'info' | 'success' | 'error' | 'system', message: string) => void
}

async function requestPasskeyAssertion({
  credentialId,
  userVerification = 'required',
}: {
  credentialId: string | null
  userVerification?: UserVerificationRequirement
}): Promise<PublicKeyCredential> {
  const challenge = new Uint8Array(32)
  window.crypto.getRandomValues(challenge)

  const abortController = new AbortController()
  // Backstop the browser's own 60s WebAuthn timeout so a stalled ceremony
  // (no resolve, no reject) can't leave the unlock button spinning forever.
  let timedOut = false
  const timeoutId = window.setTimeout(() => {
    timedOut = true
    abortController.abort()
  }, 60000)
  try {
    const assertion = await withPasskeyCeremony(
      () =>
        navigator.credentials.get({
          publicKey: {
            challenge: challenge.buffer as ArrayBuffer,
            timeout: 60000,
            userVerification,
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
          },
          signal: abortController.signal,
        }) as Promise<PublicKeyCredential | null>,
    )

    if (!assertion) {
      throw new Error('Passkey assertion returned null')
    }
    await rememberAssertionPasskey(assertion)
    return assertion
  } catch (error) {
    if (timedOut) {
      throw new Error('Passkey unlock timed out. Tap Unlock to try again.')
    }
    throw error
  } finally {
    window.clearTimeout(timeoutId)
  }
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
        const result = await registerWalletPasskey(username)

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
   * Authenticate with a WebAuthn credential
   * Returns the full PublicKeyCredential for further processing
   */
  const authenticate = useCallback(
    async (credentialId: string | null): Promise<PublicKeyCredential | null> => {
      log('info', 'POST /webauthn/authenticate/options')
      log('system', 'Browser invoking navigator.credentials.get()')
      log('system', 'Verifying passkey ownership...')

      const assertion = await requestPasskeyAssertion({ credentialId })

      log('success', 'Cryptographic signature valid')
      log('info', 'POST /webauthn/authenticate/verify')

      return assertion
    },
    [log],
  )

  return {
    register,
    authenticate,
  }
}
