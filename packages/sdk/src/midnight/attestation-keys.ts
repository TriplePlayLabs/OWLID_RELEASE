/**
 * INTERNAL — TS port of `crates/proof-system/src/attestation.rs`.
 *
 * Recomputes the on-chain attestation key the Compact circuits derive
 * via `persistentHash<Vector<3, Bytes<32>>>([tag, rootHash, param])`.
 * The verifier and the wallet both call into this to look up
 * attestations on the SSE-mirrored set without round-tripping the
 * verification-service for trivial key derivation.
 *
 * Every byte recipe must stay byte-identical to the Rust mirror — a
 * single drift produces silent membership misses. Cross-checked via
 * the Rust unit tests in `attestation.rs`.
 */
import { buildAllowedSetTree, treeRootBytesLE } from './merkle.js'

const enc = new TextEncoder()

async function sha256(...chunks: Uint8Array[]): Promise<Uint8Array> {
  const len = chunks.reduce((a, c) => a + c.length, 0)
  const buf = new Uint8Array(len)
  let o = 0
  for (const c of chunks) {
    buf.set(c, o)
    o += c.length
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf))
}

function pad32(s: string): Uint8Array {
  const bytes = enc.encode(s)
  if (bytes.length > 32) throw new Error(`tag '${s}' > 32 bytes`)
  const out = new Uint8Array(32)
  out.set(bytes, 0)
  return out
}

function u128Le32(v: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let n = v & ((1n << 128n) - 1n)
  for (let i = 0; i < 16 && n > 0n; i++) {
    out[i] = Number(n & 0xffn)
    n >>= 8n
  }
  return out
}

function u16Le32(v: number): Uint8Array {
  const out = new Uint8Array(32)
  out[0] = v & 0xff
  out[1] = (v >> 8) & 0xff
  return out
}

function hexToBytes32(hex: string): Uint8Array {
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex
  if (stripped.length !== 64) {
    throw new Error(`expected 32-byte hex, got ${stripped.length / 2} bytes`)
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(stripped.substr(i * 2, 2), 16)
  }
  return out
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/** Domain tags — must match `crates/proof-system/src/attestation.rs`. */
export const TAG_AGE = 'owlid:attest:age:'
export const TAG_KYC = 'owlid:attest:kyc:'
export const TAG_NATIONALITY = 'owlid:attest:nat:'
export const TAG_RESIDENCY = 'owlid:attest:resin:'
export const TAG_AGE_RANGE = 'owlid:attest:agerng:'
export const TAG_EMAIL_VERIFIED = 'owlid:attest:email:'
export const TAG_UNIQUE_PERSONHOOD = 'owlid:attest:uniq:'

async function keyFromParts(
  tag: string,
  rootHash: Uint8Array,
  param: Uint8Array,
): Promise<Uint8Array> {
  return sha256(pad32(tag), rootHash, param)
}

/** SHA-256 of the OID4VP verifier `client_id` UTF-8 bytes. The
 *  Compact `verifierIdHash()` witness returns these 32 bytes. */
export function verifierIdHash(clientId: string): Promise<Uint8Array> {
  return Promise.resolve(crypto.subtle.digest('SHA-256', enc.encode(clientId))).then(
    (b) => new Uint8Array(b),
  )
}

/** `setHash` recipe — mirrors the Compact circuit:
 *    root    = merkleTreePathRootNoLeafHash(sorted+padded allowed-set)
 *    setHash = SHA-256( SHA-256(client_id) || rootBytesLE )
 *  Identical to `owl_proof_system::attestation::allowed_country_set_hash`. */
export async function allowedCountrySetHash(
  clientId: string,
  countries: readonly string[],
): Promise<Uint8Array> {
  const { tree } = buildAllowedSetTree(countries)
  const rootBytes = treeRootBytesLE(tree)
  const vId = await verifierIdHash(clientId)
  return sha256(vId, rootBytes)
}

/** Key for `attestAgeGte(rootHash, threshold)`. */
export function ageKey(rootHash: Uint8Array, threshold: number): Promise<Uint8Array> {
  return keyFromParts(TAG_AGE, rootHash, u128Le32(BigInt(threshold)))
}

/** Key for `attestKycGte(rootHash, threshold)`. */
export function kycKey(rootHash: Uint8Array, threshold: number): Promise<Uint8Array> {
  return keyFromParts(TAG_KYC, rootHash, u128Le32(BigInt(threshold)))
}

/** Key for `attestAgeRange(rootHash, min, max)`. Param =
 *  SHA-256(min_le16 || max_le16). */
export async function ageRangeKey(
  rootHash: Uint8Array,
  min: number,
  max: number,
): Promise<Uint8Array> {
  const param = await sha256(u16Le32(min), u16Le32(max))
  return keyFromParts(TAG_AGE_RANGE, rootHash, param)
}

/** Key for `attestEmailVerified(rootHash)` — constant zero param. */
export function emailVerifiedKey(rootHash: Uint8Array): Promise<Uint8Array> {
  return keyFromParts(TAG_EMAIL_VERIFIED, rootHash, new Uint8Array(32))
}

/** Key for `attestUniquePersonhood(rootHash, epoch, appId)`. Param =
 *  SHA-256(epoch || appId), both 32-byte hex inputs. */
export async function uniquePersonhoodKey(
  rootHash: Uint8Array,
  epoch: string,
  appId: string,
): Promise<Uint8Array> {
  const param = await sha256(hexToBytes32(epoch), hexToBytes32(appId))
  return keyFromParts(TAG_UNIQUE_PERSONHOOD, rootHash, param)
}

/** Key for `attestNationalityIn(rootHash, setHash)`. Per-verifier salt
 *  is folded into setHash, so two verifiers asking the same allowed-set
 *  produce distinct on-chain keys. */
export async function nationalityKey(
  rootHash: Uint8Array,
  clientId: string,
  countries: readonly string[],
): Promise<Uint8Array> {
  const setHash = await allowedCountrySetHash(clientId, countries)
  return keyFromParts(TAG_NATIONALITY, rootHash, setHash)
}

/** Key for `attestResidencyIn(rootHash, setHash)`. Same shape as
 *  `nationalityKey`, different tag. */
export async function residencyKey(
  rootHash: Uint8Array,
  clientId: string,
  countries: readonly string[],
): Promise<Uint8Array> {
  const setHash = await allowedCountrySetHash(clientId, countries)
  return keyFromParts(TAG_RESIDENCY, rootHash, setHash)
}

/** Convenience hex stringifier so callers don't import the encoding
 *  module just for a key lookup. */
export function keyHex(key: Uint8Array): string {
  return bytesToHex(key)
}
