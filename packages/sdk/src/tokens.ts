/**
 * Token Generation Utilities
 *
 * Type definitions for token creation results.
 */

/**
 * Token creation result
 */
export interface TokenResult {
  tokenJson: string
}

/**
 * Prepared token for WebAuthn signing
 */
export interface PreparedTokenResult {
  preparedTokenJson: string
  webauthnChallenge: string
}
