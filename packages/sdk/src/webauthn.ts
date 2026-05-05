/**
 * WebAuthn Core
 *
 * Platform-agnostic WebAuthn utilities for registration, authentication, and signing.
 * Can be used with or without React.
 */

import { decode } from 'cbor-x'
import { bufferToBase64, bufferToBase64url, base64urlToBuffer, bytesToHex } from './encoding.js'

// ============================================================================
// Types
// ============================================================================

/**
 * WebAuthn signature data for token finalization
 */
export interface WebAuthnSignatureResult {
  authenticatorData: string
  clientDataJSON: string
  signature: string
}

/**
 * Registration result with public key for credential issuance
 */
export interface WebAuthnRegistrationResult {
  credentialId: string
  publicKey: string // Base64-encoded COSE public key
  counter: number
  transports: string[]
}

/**
 * WebAuthn registration options
 */
export interface WebAuthnRegistrationOptions {
  rpName: string
  rpId: string
  userName: string
  userDisplayName?: string
  userId?: Uint8Array
  challenge?: Uint8Array
  timeout?: number
  attestation?: AttestationConveyancePreference
  authenticatorAttachment?: AuthenticatorAttachment
  userVerification?: UserVerificationRequirement
  residentKey?: ResidentKeyRequirement
}

/**
 * WebAuthn authentication options
 */
export interface WebAuthnAuthenticationOptions {
  rpId: string
  credentialId?: string
  challenge?: Uint8Array
  timeout?: number
  userVerification?: UserVerificationRequirement
  transports?: AuthenticatorTransport[]
}

/**
 * Attestation object structure decoded from CBOR
 */
interface AttestationObject {
  fmt: string
  attStmt: Record<string, unknown>
  authData: Uint8Array
}

/**
 * COSE key structure (as decoded by cbor-x)
 */
type CoseKeyMap = Map<number, unknown>

/**
 * Helper to get value from COSE key (handles both Map and plain object)
 * cbor-x may return either depending on configuration/version
 */
function getCoseValue(coseKey: unknown, key: number): unknown {
  if (coseKey instanceof Map) {
    return coseKey.get(key)
  }
  // Plain object - keys are converted to strings
  return (coseKey as Record<string, unknown>)[String(key)]
}

// ============================================================================
// CBOR/COSE Parsing
// ============================================================================

/**
 * Extract COSE public key from attestation object using cbor-x
 * The attestation object contains the authenticator data which includes the credential public key
 */
export function extractPublicKeyFromAttestation(attestationObject: ArrayBuffer): string {
  const attestation = decode(new Uint8Array(attestationObject)) as AttestationObject

  if (!attestation.authData) {
    throw new Error('Could not find authData in attestation object')
  }

  const authDataBytes = attestation.authData

  // Parse authenticator data (binary structure, not CBOR)
  // AuthData structure:
  // - rpIdHash: 32 bytes
  // - flags: 1 byte
  // - counter: 4 bytes
  // - attestedCredentialData (if AT flag set):
  //   - aaguid: 16 bytes
  //   - credIdLen: 2 bytes (big-endian)
  //   - credId: credIdLen bytes
  //   - credentialPublicKey: CBOR-encoded COSE key (rest of data)
  const flags = authDataBytes[32]
  const hasAttestedData = (flags & 0x40) !== 0

  if (!hasAttestedData) {
    throw new Error('No attested credential data in authenticator data')
  }

  // Skip to attested credential data
  let offset = 32 + 1 + 4 // rpIdHash + flags + counter
  offset += 16 // aaguid

  const credIdLen = (authDataBytes[offset] << 8) | authDataBytes[offset + 1]
  offset += 2 + credIdLen

  // Rest is the COSE public key
  const coseKey = authDataBytes.slice(offset)
  return bufferToBase64(
    coseKey.buffer.slice(coseKey.byteOffset, coseKey.byteOffset + coseKey.byteLength),
  )
}

/**
 * Convert base64-encoded COSE public key to P-256 hex string using cbor-x
 * COSE key format: CBOR map with x and y coordinates
 * Output format: SEC1 uncompressed point (04 || x || y)
 */
export function coseKeyToP256Hex(coseKeyBase64: string): string {
  // Decode base64 to bytes
  const binary = atob(coseKeyBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

  // Decode CBOR to get COSE key map
  // COSE key map uses integer keys: {1: kty, 3: alg, -1: crv, -2: x, -3: y}
  const coseKey = decode(bytes)

  const x = getCoseValue(coseKey, -2) as Uint8Array
  const y = getCoseValue(coseKey, -3) as Uint8Array

  if (!x || !y) {
    throw new Error('Could not extract x and y coordinates from COSE key')
  }

  // Construct SEC1 uncompressed point: 04 || x || y
  const sec1 = new Uint8Array(1 + x.length + y.length)
  sec1[0] = 0x04 // Uncompressed point indicator
  sec1.set(x, 1)
  sec1.set(y, 1 + x.length)

  return bytesToHex(sec1)
}

/**
 * Parse COSE key and extract key type information
 */
export function parseCoseKey(coseKeyBase64: string): {
  kty: number
  alg: number
  crv: number
  x: Uint8Array
  y: Uint8Array
} {
  const binary = atob(coseKeyBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

  const coseKey = decode(bytes)

  return {
    kty: getCoseValue(coseKey, 1) as number,
    alg: getCoseValue(coseKey, 3) as number,
    crv: getCoseValue(coseKey, -1) as number,
    x: getCoseValue(coseKey, -2) as Uint8Array,
    y: getCoseValue(coseKey, -3) as Uint8Array,
  }
}

// ============================================================================
// WebAuthn Operations
// ============================================================================

/**
 * Register a new WebAuthn credential
 * Returns the credential ID and COSE public key for use in credential issuance
 */
export async function registerCredential(
  options: WebAuthnRegistrationOptions,
): Promise<WebAuthnRegistrationResult> {
  const challengeSource = options.challenge ?? crypto.getRandomValues(new Uint8Array(32))
  const userIdSource = options.userId ?? crypto.getRandomValues(new Uint8Array(16))

  // Copy to new ArrayBuffer to ensure compatibility with BufferSource type
  const challenge = new Uint8Array(challengeSource).buffer as ArrayBuffer
  const userId = new Uint8Array(userIdSource).buffer as ArrayBuffer

  const publicKeyCredentialCreationOptions: PublicKeyCredentialCreationOptions = {
    challenge,
    rp: {
      name: options.rpName,
      id: options.rpId,
    },
    user: {
      id: userId,
      name: options.userName,
      displayName: options.userDisplayName ?? options.userName,
    },
    pubKeyCredParams: [
      { alg: -7, type: 'public-key' }, // ES256 (P-256) - preferred for WebAuthn
    ],
    authenticatorSelection: {
      authenticatorAttachment: options.authenticatorAttachment ?? 'platform',
      userVerification: options.userVerification ?? 'required',
      residentKey: options.residentKey ?? 'preferred',
    },
    timeout: options.timeout ?? 60000,
    attestation: options.attestation ?? 'none',
  }

  const credential = (await navigator.credentials.create({
    publicKey: publicKeyCredentialCreationOptions,
  })) as PublicKeyCredential

  if (!credential) {
    throw new Error('Credential creation returned null')
  }

  const response = credential.response as AuthenticatorAttestationResponse

  // Extract COSE public key from attestation object
  const publicKey = extractPublicKeyFromAttestation(response.attestationObject)

  // Get transports if available
  const transports = response.getTransports?.() || ['internal']

  return {
    credentialId: bufferToBase64url(credential.rawId),
    publicKey,
    counter: 0, // Initial counter
    transports,
  }
}

/**
 * Sign a challenge using WebAuthn for token generation
 * The challenge should be base64url-encoded and bound to the token payload
 */
export async function signChallenge(
  credentialId: string,
  challenge: string,
  options?: Partial<WebAuthnAuthenticationOptions>,
): Promise<WebAuthnSignatureResult> {
  const challengeBuffer = base64urlToBuffer(challenge)

  const publicKeyCredentialRequestOptions: PublicKeyCredentialRequestOptions = {
    challenge: challengeBuffer,
    timeout: options?.timeout ?? 60000,
    userVerification: options?.userVerification ?? 'required',
    rpId: options?.rpId ?? window.location.hostname,
    allowCredentials: [
      {
        id: base64urlToBuffer(credentialId),
        type: 'public-key',
        transports: options?.transports ?? ['internal', 'hybrid'],
      },
    ],
  }

  const assertion = (await navigator.credentials.get({
    publicKey: publicKeyCredentialRequestOptions,
  })) as PublicKeyCredential

  if (!assertion) {
    throw new Error('WebAuthn signing returned null')
  }

  const response = assertion.response as AuthenticatorAssertionResponse

  return {
    authenticatorData: bufferToBase64(response.authenticatorData),
    clientDataJSON: bufferToBase64(response.clientDataJSON),
    signature: bufferToBase64(response.signature),
  }
}

/**
 * Authenticate with a WebAuthn credential
 * Returns the full assertion for verification
 */
export async function authenticate(options: WebAuthnAuthenticationOptions): Promise<{
  credentialId: string
  authenticatorData: string
  clientDataJSON: string
  signature: string
  userHandle: string | null
}> {
  const challengeSource = options.challenge ?? crypto.getRandomValues(new Uint8Array(32))
  // Copy to new ArrayBuffer to ensure compatibility with BufferSource type
  const challenge = new Uint8Array(challengeSource).buffer as ArrayBuffer

  const publicKeyCredentialRequestOptions: PublicKeyCredentialRequestOptions = {
    challenge,
    timeout: options.timeout ?? 60000,
    userVerification: options.userVerification ?? 'preferred',
    rpId: options.rpId,
    allowCredentials: options.credentialId
      ? [
          {
            id: base64urlToBuffer(options.credentialId),
            type: 'public-key',
            transports: options.transports ?? ['internal', 'hybrid'],
          },
        ]
      : undefined,
  }

  const assertion = (await navigator.credentials.get({
    publicKey: publicKeyCredentialRequestOptions,
  })) as PublicKeyCredential

  if (!assertion) {
    throw new Error('Credential assertion returned null')
  }

  const response = assertion.response as AuthenticatorAssertionResponse

  return {
    credentialId: bufferToBase64url(assertion.rawId),
    authenticatorData: bufferToBase64(response.authenticatorData),
    clientDataJSON: bufferToBase64(response.clientDataJSON),
    signature: bufferToBase64(response.signature),
    userHandle: response.userHandle ? bufferToBase64url(response.userHandle) : null,
  }
}

/**
 * Check if WebAuthn is supported in the current environment
 */
export function isWebAuthnSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.credentials !== 'undefined' &&
    typeof navigator.credentials.create === 'function' &&
    typeof navigator.credentials.get === 'function'
  )
}

/**
 * Check if platform authenticator (e.g., Touch ID, Face ID, Windows Hello) is available
 */
export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isWebAuthnSupported()) {
    return false
  }

  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}
