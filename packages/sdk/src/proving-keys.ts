/**
 * Groth16 proving-key delivery for the WASM build of the native SDK.
 *
 * Native (NAPI) builds embed the proving keys; this module is a no-op there.
 * Browser/WASM builds leave the keys out (they would inflate the WASM blob)
 * and acquire them at runtime through one of three sources, in this priority
 * order:
 *
 *   1. Bytes the app handed in via `configureProvingKeys({ bytes: ... })`
 *      (e.g. imported from a `?url` Vite asset, bundled by the app).
 *   2. A custom `loader(circuit) => Promise<Uint8Array>` the app set on the
 *      same call (e.g. fetch from the app's CDN, IPFS, OPFS, anywhere).
 *   3. The default loader: GET `${baseUrl}/<circuit>.pk.bin`. `baseUrl`
 *      defaults to `${getVerificationUrl()}/zk-keys` — same trusted origin
 *      the app already verifies against.
 *
 * Whatever the source, bytes go through a layered cache so the slow path
 * runs at most once per device per circuit:
 *
 *   - in-memory `Map`: rest of the page life
 *   - IndexedDB store (`owlid-zk-keys/keys`): survives reloads
 *   - HTTP cache (`Cache-Control: immutable` set by verifier): survives
 *     IndexedDB eviction
 *
 * Apps don't need to call anything explicitly — `signToken`,
 * `signTokenWithPasskey`, `respondToPresentation` all await the right
 * keys before proving. `configureProvingKeys` is only for overriding the
 * source.
 */

import { provingKeysRequired, setProvingKeyBytes } from '@owlid/native-sdk'
import { getVerificationUrl } from './config.js'

/** The three circuit families currently shipped. Match the artifact names
 * under `crates/zk-circuits/artifacts/`. */
export type ZkCircuit = 'age_range' | 'kyc_status' | 'nationality'

const ALL_CIRCUITS: ZkCircuit[] = ['age_range', 'kyc_status', 'nationality']

/** Configuration for proving-key acquisition. */
export interface ProvingKeyConfig {
  /**
   * Pre-supplied bytes for one or more circuits. Highest priority — if
   * present, no fetch is attempted. Useful for apps that bundle the keys
   * with their own assets (Vite `?url`, webpack asset modules, etc.).
   */
  bytes?: Partial<Record<ZkCircuit, Uint8Array>>
  /**
   * Custom loader, called once per circuit when bytes are not pre-supplied.
   * The result is cached in IndexedDB by default — pass
   * `cache: false` to opt out (e.g. if the loader already caches).
   */
  loader?: (circuit: ZkCircuit) => Promise<Uint8Array>
  /**
   * Base URL for the default loader. Defaults to
   * `${getVerificationUrl()}/zk-keys`. Ignored when `loader` is set.
   * Trailing slashes are tolerated.
   */
  baseUrl?: string
  /**
   * Cache fetched bytes in IndexedDB. Defaults to `true`. Set to `false`
   * if your loader already persists, or for ephemeral testing.
   */
  cache?: boolean
}

let config: Required<Omit<ProvingKeyConfig, 'loader' | 'baseUrl' | 'bytes'>> & {
  loader?: ProvingKeyConfig['loader']
  baseUrl?: string
  bytes: Partial<Record<ZkCircuit, Uint8Array>>
} = {
  cache: true,
  bytes: {},
}

/** In-memory cache so a page reload doesn't refetch from IndexedDB. */
const memoryCache = new Map<ZkCircuit, Uint8Array>()
/** Tracks circuits already handed to WASM so we don't double-load. */
const installed = new Set<ZkCircuit>()
/** Per-circuit in-flight load promise — coalesces concurrent callers. */
const inflight = new Map<ZkCircuit, Promise<void>>()

/**
 * Override how proving keys are sourced. Call once at app startup, before
 * the first proof. Calling again merges new fields into the existing
 * config; pass `null` to a field to clear it.
 *
 * Examples:
 *
 *   // Use bytes the app already bundled
 *   configureProvingKeys({ bytes: { age_range: ageRangeBytes } })
 *
 *   // Fetch from a custom CDN instead of the verifier
 *   configureProvingKeys({ baseUrl: 'https://cdn.mine.com/zk' })
 *
 *   // Hand in a fully custom loader
 *   configureProvingKeys({ loader: async (c) => fetchFromBlobStore(c) })
 */
export function configureProvingKeys(next: ProvingKeyConfig): void {
  config = {
    ...config,
    ...next,
    bytes: { ...config.bytes, ...next.bytes },
  }
}

/** Read the active config. Useful for diagnostics. */
export function getProvingKeyConfig(): Readonly<ProvingKeyConfig> {
  return config
}

/**
 * Make sure every shipped circuit's proving key is loaded. No-op on native
 * builds. Idempotent + concurrency-safe.
 */
export async function ensureProvingKeys(): Promise<void> {
  if (!provingKeysRequired()) return
  await ensureProvingKeysFor(ALL_CIRCUITS)
}

/**
 * Make sure exactly the circuits in `circuits` are loaded. Used by the
 * holder helpers to load only what a given proof request actually needs
 * (e.g. an age-only presentation skips the larger nationality key).
 */
export async function ensureProvingKeysFor(circuits: ZkCircuit[]): Promise<void> {
  if (!provingKeysRequired()) return
  const unique = Array.from(new Set(circuits))
  await Promise.all(unique.map(ensureOne))
}

/**
 * Map predicate metadata → which circuits a holder needs to prove it.
 * Holders use this to load only the keys a given verifier actually asked
 * for. Names match the artifact set under `crates/zk-circuits/artifacts/`.
 *
 * Mirrors the dispatch in `crates/proof-system/src/zk.rs`'s
 * `generate_predicate_proof`: keep the two in sync when adding circuits.
 */
export function circuitsForPredicates(
  predicates: Array<{ attribute: string; op: string }>,
): ZkCircuit[] {
  const set = new Set<ZkCircuit>()
  for (const p of predicates) {
    if (p.attribute === 'dateOfBirth' && p.op === 'GreaterOrEqual') {
      set.add('age_range')
    } else if (p.attribute === 'nationality' && p.op === 'InSet') {
      set.add('nationality')
    } else if (
      (p.attribute === 'verificationLevel' && p.op === 'GreaterOrEqual') ||
      (p.attribute === 'isResident' && p.op === 'GreaterOrEqual')
    ) {
      set.add('kyc_status')
    }
  }
  return [...set]
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function ensureOne(circuit: ZkCircuit): Promise<void> {
  if (installed.has(circuit)) return Promise.resolve()
  const existing = inflight.get(circuit)
  if (existing) return existing
  const p = (async () => {
    try {
      const bytes = await loadBytes(circuit)
      // napi-rs accepts any ArrayBufferView for `Buffer` params; pass the
      // Uint8Array directly so we don't depend on the Node `Buffer` global
      // in the browser.
      setProvingKeyBytes(circuit, bytes as unknown as Buffer)
      installed.add(circuit)
    } finally {
      inflight.delete(circuit)
    }
  })()
  inflight.set(circuit, p)
  return p
}

async function loadBytes(circuit: ZkCircuit): Promise<Uint8Array> {
  // 1. Pre-supplied bytes win unconditionally.
  const supplied = config.bytes[circuit]
  if (supplied) return supplied

  // 2. Memory cache.
  const mem = memoryCache.get(circuit)
  if (mem) return mem

  // 3. IndexedDB cache (only when caching is enabled).
  if (config.cache) {
    const fromIdb = await readIdb(circuit).catch(() => null)
    if (fromIdb) {
      memoryCache.set(circuit, fromIdb)
      return fromIdb
    }
  }

  // 4. Loader (custom or default).
  const loader = config.loader ?? defaultLoader
  const fetched = await loader(circuit)
  memoryCache.set(circuit, fetched)
  if (config.cache) {
    writeIdb(circuit, fetched).catch(() => {
      // Best-effort persist; missing IndexedDB (private mode, old browsers)
      // is not fatal — we'll just refetch next session.
    })
  }
  return fetched
}

async function defaultLoader(circuit: ZkCircuit): Promise<Uint8Array> {
  const base = (config.baseUrl ?? `${getVerificationUrl()}/zk-keys`).replace(/\/+$/, '')
  const url = `${base}/${circuit}.pk.bin`
  if (typeof fetch === 'undefined') {
    throw new Error(
      `Proving key loader needs a fetch implementation (target ${circuit}). ` +
        `Provide one via configureProvingKeys({ loader }).`,
    )
  }
  const res = await fetch(url, { cache: 'force-cache' })
  if (!res.ok) {
    throw new Error(`Failed to fetch proving key for ${circuit} from ${url}: ${res.status}`)
  }
  return new Uint8Array(await res.arrayBuffer())
}

// ---------------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------------

const DB_NAME = 'owlid-zk-keys'
const STORE_NAME = 'keys'
const DB_VERSION = 1

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function readIdb(circuit: ZkCircuit): Promise<Uint8Array | null> {
  const db = await openDb()
  try {
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(circuit)
      req.onsuccess = () => {
        const v = req.result
        resolve(v instanceof Uint8Array ? v : null)
      }
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

async function writeIdb(circuit: ZkCircuit, bytes: Uint8Array): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(bytes, circuit)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}
