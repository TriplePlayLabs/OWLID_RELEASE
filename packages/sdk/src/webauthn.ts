/**
 * WebAuthn Core
 *
 * Platform-agnostic WebAuthn utilities for registration, authentication, and signing.
 * Can be used with or without React.
 */

import { decode } from 'cbor-x'
import {
  bufferToBase64,
  bufferToBase64url,
  base64urlToBuffer,
  bytesToHex,
  hexToBytes,
} from './encoding.js'

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
  excludeCredentialIds?: string[]
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
      residentKey: options.residentKey ?? 'required',
      requireResidentKey: (options.residentKey ?? 'required') === 'required',
    },
    timeout: options.timeout ?? 60000,
    attestation: options.attestation ?? 'none',
    // Enable the WebAuthn PRF extension at creation so the passkey can
    // later derive a stable per-credential secret used to encrypt the
    // wallet-held SD-JWT VC holder key at rest. See sealHolderKey.
    extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    excludeCredentials: options.excludeCredentialIds?.map((credentialId) => ({
      id: base64urlToBuffer(credentialId),
      type: 'public-key' as const,
      transports: ['internal', 'hybrid'] as AuthenticatorTransport[],
    })),
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

// ============================================================================
// WebAuthn-PRF-wrapped holder key (at-rest protection + user-verification gate)
// ============================================================================
//
// The SD-JWT VC `cnf` key is a wallet-held Ed25519 key. To avoid storing its
// seed in plaintext localStorage (XSS-exfiltratable), it is encrypted with a
// key derived from the passkey's WebAuthn PRF output. Decryption requires the
// passkey (biometric/UV) — so localStorage theft alone is useless and every
// presentation is gated by user verification.

const HOLDER_KEY_PRF_SALT = new TextEncoder().encode('owlid:sd-jwt-vc:holder-key:v1')
const RECOVERY_PRF_SALT = new TextEncoder().encode('owlid:credential-recovery:v1')

interface PrfMaterial {
  secret: Uint8Array
  credentialId: string
}

function normalizePrfOutput(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (Array.isArray(value) && value.every((n) => typeof n === 'number')) {
    return new Uint8Array(value as number[])
  }
  if (
    typeof (value as { length?: unknown }).length === 'number' &&
    Number.isFinite((value as { length: number }).length)
  ) {
    return Uint8Array.from(value as ArrayLike<number>)
  }
  throw new Error(
    `Passkey PRF returned an unsupported value type (${Object.prototype.toString.call(value)})`,
  )
}

async function prfSecret(credentialId: string | null, salt: Uint8Array): Promise<PrfMaterial> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer,
      allowCredentials: credentialId
        ? [{ id: base64urlToBuffer(credentialId), type: 'public-key' }]
        : undefined,
      userVerification: 'required',
      timeout: 60000,
      extensions: {
        prf: { eval: { first: salt } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null
  if (!assertion) throw new Error('Passkey assertion cancelled')
  const selectedCredentialId = bufferToBase64url(assertion.rawId)
  const ext = assertion.getClientExtensionResults() as {
    prf?: { results?: { first?: unknown } }
  }
  const first = ext.prf?.results?.first
  if (!first) {
    throw new Error(
      'Passkey does not support the PRF extension; cannot securely store the holder key',
    )
  }
  return { secret: normalizePrfOutput(first), credentialId: selectedCredentialId }
}

async function prfAesKey(
  credentialId: string | null,
  salt: Uint8Array,
): Promise<{ key: CryptoKey; credentialId: string }> {
  const { secret, credentialId: selectedCredentialId } = await prfSecret(credentialId, salt)
  return crypto.subtle
    .importKey('raw', secret as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
    .then((key) => ({ key, credentialId: selectedCredentialId }))
}

/**
 * Encrypt the Ed25519 holder seed with a key derived from the passkey PRF.
 * Triggers a user-verification prompt. Returns an opaque `<iv>.<ct>` blob to
 * persist instead of the plaintext seed.
 */
/**
 * Encrypt a holder seed and report which passkey supplied the PRF output.
 * Passing `null` lets the browser present the discoverable-passkey picker.
 */
export async function sealHolderKey(
  credentialId: string | null,
  seedHex: string,
): Promise<{ blob: string; credentialId: string }> {
  const { key, credentialId: selectedCredentialId } = await prfAesKey(
    credentialId,
    HOLDER_KEY_PRF_SALT,
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    hexToBytes(seedHex) as unknown as BufferSource,
  )
  return {
    blob: `${bufferToBase64url(iv.buffer as ArrayBuffer)}.${bufferToBase64url(ct)}`,
    credentialId: selectedCredentialId,
  }
}

/**
 * Decrypt a wrapped holder key and report which passkey was selected.
 * When `credentialId` is null, the browser shows the resident-passkey
 * account picker. When a stale credential id is supplied and decrypting
 * with it fails, this falls back once to the picker so synced passkeys in
 * iCloud Keychain / 1Password can repair local metadata.
 */
export async function openHolderKey(
  credentialId: string | null,
  blob: string,
): Promise<{ seedHex: string; credentialId: string }> {
  const [ivB64, ctB64] = blob.split('.')
  if (!ivB64 || !ctB64) throw new Error('Malformed wrapped holder key')
  const decryptWith = async (id: string | null) => {
    const { key, credentialId: selectedCredentialId } = await prfAesKey(id, HOLDER_KEY_PRF_SALT)
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(base64urlToBuffer(ivB64)) },
      key,
      base64urlToBuffer(ctB64),
    )
    return { seedHex: bytesToHex(new Uint8Array(pt)), credentialId: selectedCredentialId }
  }

  try {
    return await decryptWith(credentialId)
  } catch (e) {
    if (!credentialId) throw e
    return await decryptWith(null)
  }
}

/**
 * Decrypt several wrapped holder keys under a single PRF assertion. Unlike
 * {@link openRecoveryBundles} this is all-or-nothing: every blob must open (with
 * one picker fallback) or it throws, because an offline recovery export that
 * silently drops a credential would lose it. Order matches `blobs`.
 */
export async function openHolderKeys(
  credentialId: string | null,
  blobs: string[],
): Promise<{ seedHexes: string[]; credentialId: string }> {
  const decryptAll = async (id: string | null) => {
    const { key, credentialId: selectedCredentialId } = await prfAesKey(id, HOLDER_KEY_PRF_SALT)
    const seedHexes: string[] = []
    for (const blob of blobs) {
      const [ivB64, ctB64] = blob.split('.')
      if (!ivB64 || !ctB64) throw new Error('Malformed wrapped holder key')
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(base64urlToBuffer(ivB64)) },
        key,
        base64urlToBuffer(ctB64),
      )
      seedHexes.push(bytesToHex(new Uint8Array(pt)))
    }
    return { seedHexes, credentialId: selectedCredentialId }
  }
  try {
    return await decryptAll(credentialId)
  } catch (e) {
    if (!credentialId) throw e
    return await decryptAll(null)
  }
}

/**
 * Seal several holder seeds under a single PRF assertion. One user-verification
 * prompt covers every seed, so restoring N credentials at once does not fan out
 * into N biometric prompts. Order of the returned blobs matches `seedHexes`.
 */
export async function sealHolderKeys(
  credentialId: string | null,
  seedHexes: string[],
): Promise<{ blobs: string[]; credentialId: string }> {
  const { key, credentialId: selectedCredentialId } = await prfAesKey(
    credentialId,
    HOLDER_KEY_PRF_SALT,
  )
  const blobs: string[] = []
  for (const seedHex of seedHexes) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      hexToBytes(seedHex) as unknown as BufferSource,
    )
    blobs.push(`${bufferToBase64url(iv.buffer as ArrayBuffer)}.${bufferToBase64url(ct)}`)
  }
  return { blobs, credentialId: selectedCredentialId }
}

/**
 * Decrypt several recovery blobs under a single PRF assertion. Blobs sealed by a
 * different passkey simply fail to decrypt and are dropped, so the result holds
 * only the payloads this passkey can open (order preserved, gaps removed). When
 * a stale credential id opens nothing, this falls back once to the picker so a
 * synced passkey can still recover.
 */
export async function openRecoveryBundles(
  credentialId: string | null,
  blobs: string[],
): Promise<{ payloads: string[]; credentialId: string }> {
  const decryptAll = async (id: string | null) => {
    const { key, credentialId: selectedCredentialId } = await prfAesKey(id, RECOVERY_PRF_SALT)
    const payloads: string[] = []
    for (const blob of blobs) {
      const [ivB64, ctB64] = blob.split('.')
      if (!ivB64 || !ctB64) continue
      try {
        const pt = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: new Uint8Array(base64urlToBuffer(ivB64)) },
          key,
          base64urlToBuffer(ctB64),
        )
        payloads.push(new TextDecoder().decode(pt))
      } catch {
        // Sealed under a different passkey — not recoverable on this device.
      }
    }
    return { payloads, credentialId: selectedCredentialId }
  }

  const first = await decryptAll(credentialId)
  if (first.payloads.length > 0 || !credentialId) return first
  return decryptAll(null)
}

/**
 * Encrypt an opaque recovery payload with a passkey-derived key. This uses a
 * separate PRF salt from holder-key wrapping, so recovery backups are
 * domain-separated from local wallet key blobs.
 */
export async function sealRecoveryBundle(
  credentialId: string | null,
  payload: string,
): Promise<{ blob: string; credentialId: string }> {
  const { key, credentialId: selectedCredentialId } = await prfAesKey(
    credentialId,
    RECOVERY_PRF_SALT,
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(payload) as unknown as BufferSource,
  )
  return {
    blob: `${bufferToBase64url(iv.buffer as ArrayBuffer)}.${bufferToBase64url(ct)}`,
    credentialId: selectedCredentialId,
  }
}

/**
 * Decrypt an opaque recovery payload and report which passkey was selected.
 * When a stale credential id is supplied and decrypting fails, this falls back
 * once to the resident-passkey picker.
 */
export async function openRecoveryBundle(
  credentialId: string | null,
  blob: string,
): Promise<{ payload: string; credentialId: string }> {
  const [ivB64, ctB64] = blob.split('.')
  if (!ivB64 || !ctB64) throw new Error('Malformed recovery backup')
  const decryptWith = async (id: string | null) => {
    const { key, credentialId: selectedCredentialId } = await prfAesKey(id, RECOVERY_PRF_SALT)
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(base64urlToBuffer(ivB64)) },
      key,
      base64urlToBuffer(ctB64),
    )
    return { payload: new TextDecoder().decode(pt), credentialId: selectedCredentialId }
  }

  try {
    return await decryptWith(credentialId)
  } catch (e) {
    if (!credentialId) throw e
    return await decryptWith(null)
  }
}
