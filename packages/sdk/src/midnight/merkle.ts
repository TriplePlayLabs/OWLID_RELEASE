/**
 * INTERNAL — verifier-supplied allowed-set Merkle tree.
 *
 * Both verifier and holder build the same depth-`MERKLE_DEPTH` tree
 * over the canonicalised country list so the on-chain `setHash` is
 * deterministic across both sides. Mirrors
 * `owl_proof_system::attestation::allowed_country_merkle_root` (Rust)
 * and the in-circuit `merkleTreePathRootNoLeafHash` (Compact stdlib).
 *
 * Leaf encoding: `pad32(ISO-3166-1 alpha-2)` (e.g. "NL" → `4e 4c 00 .. 00`).
 * Inner nodes: `transientHash([left, right])` (Poseidon over BLS12-381
 * outer scalar, supplied by `@midnight-ntwrk/compact-runtime`).
 * Unused leaf slots are zero bytes — the tree is fully bound, so a
 * verifier can't grind padding to forge a different root.
 *
 * Off-chain layout:
 *   leaves[0..N]    sorted+deduped+uppercased country slots, pad32
 *   leaves[N..256]  zero bytes
 *   build the full binary tree bottom-up
 *   root            = root node's degraded-to-Fr field value
 *   setHash         = SHA-256( verifierIdHash || rootBytesLE )
 *
 * `findPathFor(country)` returns the `MerkleTreePath<8, Bytes<32>>`
 * the Compact `allowedCountryPath()` witness expects.
 */
import {
  StateBoundedMerkleTree,
  Bytes32Descriptor,
  transientHash,
  CompactTypeMerkleTreePath,
  type MerkleTreePath,
  type MerkleTreeDigest,
} from '@midnight-ntwrk/compact-runtime'
import type { AlignedValue } from '@midnight-ntwrk/onchain-runtime-v3'

function alignedBytes32(bytes: Uint8Array): AlignedValue {
  return {
    value: Bytes32Descriptor.toValue(bytes),
    alignment: Bytes32Descriptor.alignment(),
  }
}

/** Depth of the per-presentation allowed-set Merkle tree (2^8 = 256
 *  leaves). Matches the Compact `Vector<8, MerklePathEntry>` /
 *  `MerkleTreePath<8, Bytes<32>>` witness type. */
export const MERKLE_DEPTH = 8
/** Maximum verifier-supplied allowed-set size (= 2^MERKLE_DEPTH). */
export const COUNTRY_SET_SLOTS = 1 << MERKLE_DEPTH

const enc = new TextEncoder()

/** Right-pad an ISO 3166-1 alpha-2 country code into a 32-byte slot.
 *  Identical to the `padCountry` in `witnesses.ts` — duplicated here
 *  so the Merkle helper has no internal cross-dependency. */
function padCountry(code: string): Uint8Array {
  const out = new Uint8Array(32)
  const bytes = enc.encode(code.toUpperCase())
  out.set(bytes.subarray(0, Math.min(bytes.length, 32)))
  return out
}

/** Canonicalise a verifier-supplied country list: uppercase + alpha-2
 *  filter + dedupe + sort. Mirrors the Rust `canonicalise_countries`
 *  so both sides compute the same root. */
export function canonicaliseCountries(codes: ReadonlyArray<string>): string[] {
  const seen = new Set<string>()
  for (const raw of codes) {
    if (typeof raw !== 'string') continue
    const code = raw.trim().toUpperCase()
    if (code.length === 2 && /^[A-Z]{2}$/.test(code)) seen.add(code)
  }
  return [...seen].sort()
}

interface BuiltTree {
  /** Fully-hashed StateBoundedMerkleTree for path lookups. */
  tree: StateBoundedMerkleTree
  /** Canonical leaves in tree-index order (length = COUNTRY_SET_SLOTS). */
  leaves: Uint8Array[]
  /** Country → tree index (only populated for non-empty slots). */
  indexByCountry: Map<string, number>
}

/** Build the depth-`MERKLE_DEPTH` tree from a canonical (sorted +
 *  deduped + uppercased) country list. Empty slots are zero-byte
 *  leaves; the resulting root is deterministic. */
function buildCanonicalTree(canon: ReadonlyArray<string>): BuiltTree {
  if (canon.length > COUNTRY_SET_SLOTS) {
    throw new Error(`allowedCountrySet exceeds cap: ${canon.length} > ${COUNTRY_SET_SLOTS}`)
  }
  const leaves: Uint8Array[] = new Array(COUNTRY_SET_SLOTS)
  const indexByCountry = new Map<string, number>()
  for (let i = 0; i < COUNTRY_SET_SLOTS; i++) {
    if (i < canon.length) {
      const code = canon[i]!
      leaves[i] = padCountry(code)
      indexByCountry.set(code, i)
    } else {
      leaves[i] = new Uint8Array(32)
    }
  }
  let tree = new StateBoundedMerkleTree(MERKLE_DEPTH)
  for (let i = 0; i < COUNTRY_SET_SLOTS; i++) {
    tree = tree.update(BigInt(i), alignedBytes32(leaves[i]!))
  }
  tree = tree.rehash()
  return { tree, leaves, indexByCountry }
}

/** Build the tree from a possibly-raw country list (any case / order
 *  / duplicates) and return the helper bundle. */
export function buildAllowedSetTree(codes: ReadonlyArray<string>): BuiltTree {
  return buildCanonicalTree(canonicaliseCountries(codes))
}

/** Same root, serialized to 32 LE bytes — the encoding the Compact
 *  `disclose(root.field) as Bytes<32>` cast produces. The
 *  `StateBoundedMerkleTree.root()` AlignedValue carries a single Fr
 *  atom whose `value[0]` is the field bytes in little-endian. */
export function treeRootBytesLE(tree: StateBoundedMerkleTree): Uint8Array {
  const rootValue = tree.root()
  if (!rootValue) {
    throw new Error('StateBoundedMerkleTree.root() returned undefined (call rehash() first)')
  }
  const bytes = rootValue.value[0] as Uint8Array
  const out = new Uint8Array(32)
  out.set(bytes.subarray(0, Math.min(bytes.length, 32)))
  return out
}

/** Build the `MerkleTreePath<8, Bytes<32>>` value the Compact
 *  `allowedCountryPath()` witness consumes. `holderCountry` is the
 *  alpha-2 ISO code that must appear in the canonical set; throws if
 *  it isn't. */
export function findPathForCountry(
  built: BuiltTree,
  holderCountry: string,
): MerkleTreePath<Uint8Array> {
  const upper = holderCountry.toUpperCase()
  const idx = built.indexByCountry.get(upper)
  if (idx === undefined) {
    throw new Error(
      `holder country '${holderCountry}' not in canonical allowed-set ` +
        `(canonical leaves: ${[...built.indexByCountry.keys()].sort().join(',')})`,
    )
  }
  const leafValue = alignedBytes32(built.leaves[idx]!)
  const pathValue = built.tree.pathForLeaf(BigInt(idx), leafValue)
  const codec = new CompactTypeMerkleTreePath(MERKLE_DEPTH, Bytes32Descriptor)
  return codec.fromValue(pathValue.value)
}

/** Re-export from compact-runtime for callers that want to type
 *  witness factories without importing two packages. */
export { transientHash }
export type { MerkleTreePath, MerkleTreeDigest }
