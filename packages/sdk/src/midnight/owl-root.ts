/**
 * INTERNAL — issuer-signed claim-commitment tree (`owl_root`).
 *
 * Mirror of `owl_proof_system::attestation::{claim_commit, owl_claims_root,
 * claim_value32, owl_root_for_claims}` (Rust) and the in-circuit
 * `merkleTreePathRoot<8, Bytes<32>>`. Lets the wallet rebuild the exact root the
 * issuer signed and extract a `MerkleTreePath` proving a claim's commitment is a
 * leaf under it — the witness that binds a predicate to the credential (F-1).
 *
 * Cross-runtime parity is pinned by `owl-root.test.ts` against the Rust vector.
 */
import {
  Bytes32Descriptor,
  CompactTypeMerkleTreePath,
  type MerkleTreePath,
  StateBoundedMerkleTree,
} from '@midnight-ntwrk/compact-runtime'
import type { AlignedValue } from '@midnight-ntwrk/onchain-runtime-v3'
import { sha256 } from '@noble/hashes/sha2'

export const OWL_MERKLE_DEPTH = 8
const SLOTS = 1 << OWL_MERKLE_DEPTH
const enc = new TextEncoder()

function aligned(b: Uint8Array): AlignedValue {
  return { value: Bytes32Descriptor.toValue(b), alignment: Bytes32Descriptor.alignment() }
}

function pad32(s: string): Uint8Array {
  const out = new Uint8Array(32)
  const b = enc.encode(s)
  out.set(b.subarray(0, Math.min(b.length, 32)))
  return out
}

/** Mirror of Rust `u128_le32`: value in the low bytes, little-endian. */
function intLE32(n: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let v = n
  for (let i = 0; i < 16 && v > 0n; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

function toBigInt(v: unknown): bigint | null {
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v)
  if (typeof v === 'bigint') return v
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return BigInt(v.trim())
  return null
}

function toBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === 'true' || s === 'yes' || s === '1') return true
    if (s === 'false' || s === 'no' || s === '0') return false
  }
  return null
}

/** `"YYYY-MM-DD"` → `YYYYMMDD`. */
function dateToYmd(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim())
  if (!m) return null
  const [, y, mo, d] = m
  const mm = Number(mo)
  const dd = Number(d)
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  return Number(y) * 10_000 + mm * 100 + dd
}

/** Canonical `value as Bytes<32>` for a predicate-bearing claim, keyed by the
 *  **standard SD-JWT VC claim name** (the names the issuer signs, which is what
 *  the disclosures carry). `null` for a claim no predicate binds. Mirrors Rust
 *  `claim_value32`. */
export function claimValue32(name: string, value: unknown): Uint8Array | null {
  switch (name) {
    case 'verification_level': {
      const n = verificationLevelToNumber(value)
      return n === null ? null : intLE32(BigInt(n))
    }
    case 'birthdate': {
      const d = dateToYmd(value)
      return d === null ? null : intLE32(BigInt(d))
    }
    case 'email_verified':
    case 'resident': {
      const b = toBool(value)
      return b === null ? null : intLE32(b ? 1n : 0n)
    }
    case 'nationality':
    case 'residentCountry':
      return typeof value === 'string' ? pad32(value.toUpperCase()) : null
    case 'personhoodSecret':
      return hexTo32(value)
    default:
      return null
  }
}

function hexTo32(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') return null
  const h = value.replace(/^0x/, '')
  if (h.length !== 64 || !/^[0-9a-fA-F]+$/.test(h)) return null
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** `verification_level` label/number → level. Mirrors Rust
 *  `verification_level_to_u128` and issuer-service `verification_level_to_u64`. */
function verificationLevelToNumber(value: unknown): number | null {
  const n = toBigInt(value)
  if (n !== null) return Number(n)
  if (typeof value !== 'string') return null
  switch (value.trim().toLowerCase()) {
    case 'none':
    case '':
      return 0
    case 'low':
    case 'basic':
      return 1
    case 'medium':
    case 'substantial':
      return 2
    case 'high':
      return 3
    default:
      return null
  }
}

/** `persistentHash([pad32(name), value32, salt32])` = `SHA-256(name32 ‖ v32 ‖ salt32)`. */
export function claimCommit(name: string, value32: Uint8Array, salt32: Uint8Array): Uint8Array {
  const buf = new Uint8Array(96)
  buf.set(pad32(name), 0)
  buf.set(value32, 32)
  buf.set(salt32, 64)
  return sha256(buf)
}

/** Per-claim `salt32` = `sha256(disclosure_salt)` — what the issuer used. */
export function salt32For(disclosureSalt: string): Uint8Array {
  return sha256(enc.encode(disclosureSalt))
}

export interface OwlRootTree {
  tree: StateBoundedMerkleTree
  leaves: Uint8Array[]
  indexByName: Map<string, number>
}

/** Build the depth-8 `owl_root` tree from a credential's claims (each
 *  `{name, value, salt}` where `salt` is the SD-JWT disclosure salt string).
 *  Non-predicate claims are skipped; predicate claims are placed in name order. */
export function buildOwlRootTree(
  claims: ReadonlyArray<{ name: string; value: unknown; salt: string }>,
): OwlRootTree {
  const commits: Array<[string, Uint8Array]> = []
  for (const c of claims) {
    const v32 = claimValue32(c.name, c.value)
    if (v32) commits.push([c.name, claimCommit(c.name, v32, salt32For(c.salt))])
  }
  commits.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  if (commits.length > SLOTS)
    throw new Error(`too many predicate claims: ${commits.length} > ${SLOTS}`)

  const leaves: Uint8Array[] = new Array(SLOTS)
  const indexByName = new Map<string, number>()
  let tree = new StateBoundedMerkleTree(OWL_MERKLE_DEPTH)
  for (let i = 0; i < SLOTS; i++) {
    leaves[i] = i < commits.length ? commits[i]![1] : new Uint8Array(32)
    tree = tree.update(BigInt(i), aligned(leaves[i]!))
    if (i < commits.length) indexByName.set(commits[i]![0], i)
  }
  tree = tree.rehash()
  return { tree, leaves, indexByName }
}

/** The `owl_root` as 32 LE bytes (`disclose(root.field) as Bytes<32>`). */
export function owlRootBytesLE(built: OwlRootTree): Uint8Array {
  const rv = built.tree.root()
  if (!rv) throw new Error('owl_root tree not rehashed')
  const b = rv.value[0] as Uint8Array
  const out = new Uint8Array(32)
  out.set(b.subarray(0, Math.min(b.length, 32)))
  return out
}

/** The `MerkleTreePath<8, Bytes<32>>` the circuit's `claimPath()` witness wants. */
export function findClaimPath(built: OwlRootTree, name: string): MerkleTreePath<Uint8Array> {
  const idx = built.indexByName.get(name)
  if (idx === undefined) throw new Error(`claim '${name}' is not bound in owl_root`)
  const pathValue = built.tree.pathForLeaf(BigInt(idx), aligned(built.leaves[idx]!))
  const codec = new CompactTypeMerkleTreePath(OWL_MERKLE_DEPTH, Bytes32Descriptor)
  return codec.fromValue(pathValue.value)
}
