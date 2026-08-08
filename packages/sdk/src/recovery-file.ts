// Offline, passkey-independent recovery file.
//
// The at-rest holder-key wrap and the server-side recovery backup are both
// gated by the WebAuthn PRF — so if the passkey is lost or was never synced,
// neither can be opened and the credentials are gone. This module adds the
// missing escape hatch: a downloadable file encrypted under a high-entropy
// recovery CODE the user keeps, with no passkey in the loop. Decryption needs
// only the code, so it restores onto a brand-new device with a brand-new
// passkey — which also makes it the multi-device path.
//
// Crypto: PBKDF2-SHA256 (600k) over the normalized code → AES-256-GCM. The
// domain tag `owlid:recovery-file:v1` is bound as GCM additional-data so a
// blob can never be mistaken for the PRF-salt wraps. See
// docs/DOMAIN_SEPARATION.md (tag 13).

import { base64urlToBuffer, bufferToBase64url } from './encoding.js'

const FILE_VERSION = 'owlid-recovery-file-v1'
const DOMAIN = new TextEncoder().encode('owlid:recovery-file:v1')
const PBKDF2_ITERATIONS = 600_000
const MIN_ITERATIONS = 100_000
const MAX_ITERATIONS = 2_000_000
const SALT_BYTES = 16
const IV_BYTES = 12

// Crockford base32 without I, L, O, U — unambiguous for hand-entry.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_GROUPS = 6
const CODE_GROUP_LEN = 5 // 6 × 5 chars × 5 bits = 150 bits of entropy

/** One credential plus its plaintext holder seed. `credential` is opaque to the
 *  SDK (the app passes a `WalletCredential`); the file only transports it. */
export interface RecoveryFileEntry {
  credential: unknown
  holderSeedHex: string
}

/** Encrypted, serializable recovery file. Safe to write to disk / cloud as-is. */
export interface RecoveryFile {
  v: typeof FILE_VERSION
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string }
  iv: string
  ct: string
}

interface RecoveryFilePayload {
  v: typeof FILE_VERSION
  entries: RecoveryFileEntry[]
}

/** Generate a 150-bit recovery code, grouped for legibility:
 *  `A1B2C-D3E4F-…` (6 groups of 5 Crockford-base32 chars). */
export function generateRecoveryCode(): string {
  const n = CODE_GROUPS * CODE_GROUP_LEN
  const bytes = crypto.getRandomValues(new Uint8Array(n))
  let out = ''
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % CODE_GROUP_LEN === 0) out += '-'
    out += ALPHABET[bytes[i] & 31]
  }
  return out
}

/** Fold a user-typed code to its canonical form: uppercase, map the visual
 *  confusables Crockford excludes (O→0, I/L→1), drop everything else. So
 *  dashes, spaces, and case never change the derived key. */
export function normalizeRecoveryCode(code: string): string {
  let out = ''
  for (const ch of code.toUpperCase()) {
    const mapped = ch === 'O' ? '0' : ch === 'I' || ch === 'L' ? '1' : ch
    if (ALPHABET.includes(mapped)) out += mapped
  }
  return out
}

async function deriveKey(code: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const normalized = normalizeRecoveryCode(code)
  if (normalized.length < CODE_GROUPS * CODE_GROUP_LEN) {
    throw new Error('Recovery code is too short')
  }
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(normalized) as unknown as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Encrypt credentials + seeds under `code`. No passkey involved. */
export async function encryptRecoveryFile(
  entries: RecoveryFileEntry[],
  code: string,
): Promise<RecoveryFile> {
  if (entries.length === 0) throw new Error('Nothing to back up')
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveKey(code, salt, PBKDF2_ITERATIONS)
  const payload: RecoveryFilePayload = { v: FILE_VERSION, entries }
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: DOMAIN as unknown as BufferSource },
    key,
    new TextEncoder().encode(JSON.stringify(payload)) as unknown as BufferSource,
  )
  return {
    v: FILE_VERSION,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: b64(salt) },
    iv: b64(iv),
    ct: bufferToBase64url(ct),
  }
}

/** Decrypt a recovery file with `code`. Throws on a wrong code or tampering
 *  (GCM auth failure is indistinguishable from a bad code, by design). */
export async function decryptRecoveryFile(
  file: RecoveryFile,
  code: string,
): Promise<RecoveryFileEntry[]> {
  if (!file || file.v !== FILE_VERSION) throw new Error('Unsupported recovery file format')
  if (file.kdf?.name !== 'PBKDF2' || file.kdf.hash !== 'SHA-256') {
    throw new Error('Unsupported recovery file KDF')
  }
  const iterations = file.kdf.iterations
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new Error('Recovery file has an out-of-range iteration count')
  }
  const key = await deriveKey(code, new Uint8Array(base64urlToBuffer(file.kdf.salt)), iterations)
  let pt: ArrayBuffer
  try {
    pt = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(base64urlToBuffer(file.iv)),
        additionalData: DOMAIN as unknown as BufferSource,
      },
      key,
      base64urlToBuffer(file.ct),
    )
  } catch {
    throw new Error('Invalid recovery code or corrupted recovery file')
  }
  const parsed = JSON.parse(new TextDecoder().decode(pt)) as Partial<RecoveryFilePayload>
  if (parsed.v !== FILE_VERSION || !Array.isArray(parsed.entries)) {
    throw new Error('Recovery file payload is malformed')
  }
  return parsed.entries
}

function b64(bytes: Uint8Array): string {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return bufferToBase64url(copy.buffer)
}
