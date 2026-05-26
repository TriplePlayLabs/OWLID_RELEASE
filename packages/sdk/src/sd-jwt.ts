/**
 * Pure-TS SD-JWT VC holder + verify primitives.
 *
 * Standards: RFC 9901 + draft-ietf-oauth-sd-jwt-vc. Bytes match
 * `owl_proof_system::sd_jwt` so the verification-service accepts our
 * presentations unchanged — same JSON serialization (no whitespace),
 * same disclosure preservation (b64url strings re-emitted as-is), same
 * KB-JWT `sd_hash` computation.
 *
 * Replaces the napi/WASM `@owlid/native-sdk` for the SDK's holder path.
 * Crypto: Ed25519 via `@noble/ed25519` (sync, audited, zero-config in any
 * JS runtime); SHA-256 via `@noble/hashes`. No WebCrypto dance, no
 * platform-specific binaries.
 */
import * as ed25519 from '@noble/ed25519'
import { sha256 as nobleSha256 } from '@noble/hashes/sha2'
import { sha512 } from '@noble/hashes/sha2'
import { bytesToHex } from './encoding.js'

// `@noble/ed25519` v2 stays hash-dependency-free; host wires SHA-512 once.
ed25519.etc.sha512Sync = (...msgs: Uint8Array[]): Uint8Array => {
  const total = msgs.reduce((n, m) => n + m.length, 0)
  const buf = new Uint8Array(total)
  let o = 0
  for (const m of msgs) {
    buf.set(m, o)
    o += m.length
  }
  return sha512(buf)
}

// ---------------------------------------------------------------------------
// Encoding primitives — base64url, hex, utf8.
// ---------------------------------------------------------------------------

const HEX_CHARS = '0123456789abcdef'

function hexEncode(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += HEX_CHARS[b >> 4] + HEX_CHARS[b & 0x0f]
  return out
}

function hexDecode(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return out
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function utf8String(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/** SHA-256 of `data`, raw bytes. */
function sha256Bytes(data: Uint8Array): Uint8Array {
  return nobleSha256(data)
}

// ---------------------------------------------------------------------------
// KeyPair — wallet-held Ed25519 holder `cnf`.
// ---------------------------------------------------------------------------

/**
 * A wallet-held Ed25519 key pair. Its public key is bound as the
 * SD-JWT VC `cnf`; the private seed signs the KB-JWT at presentation.
 * Persist `toHex()` (32-byte seed) in the wallet's secure storage.
 */
export class KeyPair {
  /** 32-byte Ed25519 private seed. */
  private readonly seed: Uint8Array

  private constructor(seed: Uint8Array) {
    if (seed.length !== 32) throw new Error('Ed25519 seed must be 32 bytes')
    this.seed = seed
  }

  /** Generate a fresh Ed25519 holder key. */
  static generate(): KeyPair {
    return new KeyPair(ed25519.utils.randomPrivateKey())
  }

  /** Restore from a hex-encoded 32-byte seed (64 hex chars). */
  static fromHex(privateKeyHex: string): KeyPair {
    return new KeyPair(hexDecode(privateKeyHex))
  }

  /** Public key, hex (32 bytes / 64 hex chars). The `cnf` key. */
  publicKeyHex(): string {
    return hexEncode(ed25519.getPublicKey(this.seed))
  }

  /** Private seed, hex. Secret — store securely. */
  toHex(): string {
    return hexEncode(this.seed)
  }
}

/** An Ed25519 public key (issuer or holder), hex-encoded. */
export class PublicKey {
  private constructor(public readonly hex: string) {}
  static fromHex(hex: string): PublicKey {
    if (hexDecode(hex).length !== 32) throw new Error('Ed25519 pubkey must be 32 bytes')
    return new PublicKey(hex.toLowerCase())
  }
  toHex(): string {
    return this.hex
  }
}

// ---------------------------------------------------------------------------
// JOSE primitives — JWS sign/verify (EdDSA).
// ---------------------------------------------------------------------------

const JWT_TYP = 'dc+sd-jwt'
const JWT_TYP_LEGACY = 'vc+sd-jwt'
const KB_TYP = 'kb+jwt'
const SD_ALG = 'sha-256'
const ALG_EDDSA = 'EdDSA'

function jsonNoWhitespace(value: unknown): string {
  return JSON.stringify(value)
}

function jwsSignEd25519(header: object, payload: object, privSeedHex: string): string {
  const h = b64urlEncode(utf8Bytes(jsonNoWhitespace(header)))
  const p = b64urlEncode(utf8Bytes(jsonNoWhitespace(payload)))
  const signingInput = `${h}.${p}`
  const sig = ed25519.sign(utf8Bytes(signingInput), hexDecode(privSeedHex))
  return `${signingInput}.${b64urlEncode(sig)}`
}

function jwsVerifyEd25519(token: string, pubKeyHex: string): { header: any; payload: any } {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('JWS must have 3 parts')
  const signingInput = `${parts[0]}.${parts[1]}`
  const ok = ed25519.verify(b64urlDecode(parts[2]), utf8Bytes(signingInput), hexDecode(pubKeyHex))
  if (!ok) throw new Error('JWS signature invalid')
  const header = JSON.parse(utf8String(b64urlDecode(parts[0])))
  const payload = JSON.parse(utf8String(b64urlDecode(parts[1])))
  return { header, payload }
}

// ---------------------------------------------------------------------------
// SD-JWT VC.
// ---------------------------------------------------------------------------

/** Key Binding input. Holder signs EdDSA over `aud`/`nonce`/`sd_hash`. */
export interface KbInput {
  /** Holder Ed25519 private seed, hex. */
  holderPrivateKeyHex: string
  /** Verifier identifier the presentation is bound to (KB-JWT `aud`). */
  aud: string
  /** Verifier nonce / challenge. */
  nonce: string
  /** Issued-at, unix seconds. */
  iat: number
}

/** Verifier-facing verification result. */
export interface VerificationResult {
  valid: boolean
  /** JSON object of disclosed claims (stringified). */
  claims?: string
  issuer?: string
  credentialType?: string
  keyBound: boolean
  error?: string
}

/**
 * Parsed SD-JWT VC. Holds the issuer JWT and the available Disclosures;
 * `present()` re-emits a selected subset (Disclosure b64url strings
 * preserved byte-for-byte) plus an optional Key Binding JWT.
 */
export class SdJwtVc {
  private constructor(
    /** Issuer JWT (`header.payload.signature`). */
    private readonly jwt: string,
    /** `[claimName, disclosureB64url]` in original order. */
    private readonly disclosures: Array<[string, string]>,
  ) {}

  /** Parse an SD-JWT VC (issuance or presentation form). */
  static parse(sdJwt: string): SdJwtVc {
    const parts = sdJwt.split('~')
    if (parts.length < 2) throw new Error('not an SD-JWT (no ~)')
    const jwt = parts[0]
    // Issuance form ends with empty trailing element (...`~`); presentation
    // form's last element is the KB-JWT. We ignore the KB on parse — the
    // holder only re-emits Disclosures plus its own KB.
    const last = parts[parts.length - 1]
    const disclosureSlice = last === '' ? parts.slice(1, -1) : parts.slice(1, -1)
    const disclosures: Array<[string, string]> = []
    for (const d of disclosureSlice) {
      if (d === '') continue
      const arr = JSON.parse(utf8String(b64urlDecode(d)))
      if (!Array.isArray(arr) || typeof arr[1] !== 'string') {
        throw new Error('disclosure missing claim name')
      }
      disclosures.push([arr[1], d])
    }
    return new SdJwtVc(jwt, disclosures)
  }

  /** Issuance form: `JWT~D1~..~Dn~` (all Disclosures, no Key Binding). */
  serialize(): string {
    let s = this.jwt + '~'
    for (const [, d] of this.disclosures) s += d + '~'
    return s
  }

  /**
   * Stable credential id = `base64url(sha-256(issuer JWT))`. Same for
   * the issuance form and any presentation (the issuer JWT is unchanged
   * across presentations). On-chain anchor / revocation handle.
   */
  credentialId(): string {
    return b64urlEncode(sha256Bytes(utf8Bytes(this.jwt)))
  }

  /**
   * Hex form of {@link credentialId} — the 32-byte Bytes<32> shape
   * Midnight Compact contracts and the verifier-service `/predicates/*`
   * endpoints take. Mirrors Rust `sd_jwt::credential_id_hex`.
   */
  credentialIdHex(): string {
    return bytesToHex(sha256Bytes(utf8Bytes(this.jwt)))
  }

  /**
   * The set of selectively-disclosable claim names this credential
   * carries. Uses the SD-JWT VC standard names exactly as issued
   * (snake_case / OIDC convention), which is the same surface DCQL
   * queries against — no mapping needed downstream.
   */
  disclosedClaimNames(): string[] {
    return this.disclosures.map(([name]) => name)
  }

  /**
   * Decoded value of a single disclosed claim. `null` when the claim
   * isn't disclosed by this credential.
   */
  disclosedClaim(name: string): unknown {
    const entry = this.disclosures.find(([n]) => n === name)
    if (!entry) return null
    const arr = JSON.parse(utf8String(b64urlDecode(entry[1])))
    return Array.isArray(arr) ? arr[2] : null
  }

  /** Read `iss` without verifying the signature. */
  peekIssuer(): string {
    const parts = this.jwt.split('.')
    if (parts.length !== 3) throw new Error('issuer JWT must have 3 parts')
    const payload = JSON.parse(utf8String(b64urlDecode(parts[1])))
    if (typeof payload.iss !== 'string') throw new Error('iss missing')
    return payload.iss
  }

  /**
   * Re-emit disclosing only `disclose`, optionally appending a standard
   * EdDSA KB-JWT bound (via `sd_hash`) to exactly the presented
   * Disclosures. Disclosure bytes are preserved as the issuer produced
   * them so the verifier's `_sd` digest match holds.
   */
  present(disclose: string[], kb?: KbInput | null): string {
    let s = this.jwt + '~'
    for (const name of disclose) {
      const entry = this.disclosures.find(([n]) => n === name)
      if (!entry) throw new Error(`no disclosure for '${name}'`)
      s += entry[1] + '~'
    }
    if (!kb) return s

    const sdHash = b64urlEncode(sha256Bytes(utf8Bytes(s)))
    const kbToken = jwsSignEd25519(
      { typ: KB_TYP, alg: ALG_EDDSA },
      { iat: kb.iat, aud: kb.aud, nonce: kb.nonce, sd_hash: sdHash },
      kb.holderPrivateKeyHex,
    )
    return s + kbToken
  }
}

/**
 * Verify an SD-JWT VC presentation against an Ed25519 issuer key:
 *   - issuer JWS verifies under `issuerPublicKeyHex`,
 *   - each disclosed Disclosure's digest is in `_sd`,
 *   - `_sd_alg` is `sha-256`,
 *   - if a KB-JWT is present and `requireKb`, it verifies under `cnf`
 *     and its `aud`/`nonce`/`sd_hash` match.
 *
 * Mainly useful for client-side smoke tests; the authoritative verifier
 * is `verification-service` (it also checks the Midnight trust anchor,
 * revocation, and Status List).
 */
export function verifySdJwt(
  presentation: string,
  issuerPublicKeyHex: string,
  requireKb: boolean,
  audience?: string | null,
  nonce?: string | null,
): VerificationResult {
  try {
    const segments = presentation.split('~')
    if (segments.length < 2) throw new Error('not an SD-JWT (no ~)')
    const jwt = segments[0]
    const last = segments[segments.length - 1]
    const kb = last === '' ? null : last
    const disclosureSegs = kb === null ? segments.slice(1, -1) : segments.slice(1, -1)

    // Issuer JWS.
    const { header, payload } = jwsVerifyEd25519(jwt, issuerPublicKeyHex)
    const typ = header?.typ
    if (typ !== JWT_TYP && typ !== JWT_TYP_LEGACY) {
      throw new Error('issuer JWT typ must be dc+sd-jwt')
    }
    if (payload?._sd_alg !== SD_ALG) throw new Error('_sd_alg must be sha-256')

    // Disclosure digests must be in `_sd`.
    const sdSet = new Set<string>(Array.isArray(payload._sd) ? payload._sd : [])
    const claims: Record<string, unknown> = {}
    for (const d of disclosureSegs) {
      if (!d) continue
      const digest = b64urlEncode(sha256Bytes(utf8Bytes(d)))
      if (!sdSet.has(digest)) throw new Error('disclosure not in _sd')
      const arr = JSON.parse(utf8String(b64urlDecode(d)))
      if (!Array.isArray(arr) || arr.length !== 3 || typeof arr[1] !== 'string') {
        throw new Error('bad disclosure shape')
      }
      claims[arr[1]] = arr[2]
    }

    let keyBound = false
    if (kb) {
      const cnfJwk = payload?.cnf?.jwk
      if (!cnfJwk) throw new Error('cnf.jwk missing')
      if (cnfJwk.kty !== 'OKP' || cnfJwk.crv !== 'Ed25519') {
        // ES256 is verified by the service; TS verify is EdDSA-only.
        throw new Error('TS verify only supports Ed25519 cnf')
      }
      const holderPub = hexEncode(b64urlDecode(cnfJwk.x))
      const { header: kh, payload: kp } = jwsVerifyEd25519(kb, holderPub)
      if (kh?.typ !== KB_TYP) throw new Error('KB-JWT typ must be kb+jwt')
      if (audience && kp?.aud !== audience) throw new Error('KB-JWT aud mismatch')
      if (nonce && kp?.nonce !== nonce) throw new Error('KB-JWT nonce mismatch')
      const prefix = presentation.slice(0, presentation.length - kb.length)
      const wantHash = b64urlEncode(sha256Bytes(utf8Bytes(prefix)))
      if (kp?.sd_hash !== wantHash) throw new Error('KB-JWT sd_hash mismatch')
      keyBound = true
    } else if (requireKb) {
      throw new Error('Key Binding required but absent')
    }

    return {
      valid: true,
      claims: JSON.stringify(claims),
      issuer: typeof payload.iss === 'string' ? payload.iss : undefined,
      credentialType: typeof payload.vct === 'string' ? payload.vct : undefined,
      keyBound,
    }
  } catch (e) {
    return {
      valid: false,
      keyBound: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
