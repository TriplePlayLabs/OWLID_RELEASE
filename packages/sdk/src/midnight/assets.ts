/**
 * INTERNAL — the concrete `PredicateAssets` the orchestrator
 * (`orchestrator.ts`) consumes: per-kind witness-bound contract
 * (delegated to `witnesses.ts`) + a shared `zkConfigProvider` that
 * streams compactc artifacts from the verification-service.
 *
 * No Midnight/contract/circuit concept is exposed to the SDK consumer —
 * this is the asset wiring behind the transparent one-time attest step.
 *
 * One contract per predicate kind: the per-extrinsic block-weight cap
 * on Midnight devnet forces the split. Each kind has its own circuit id
 * and its own witness signature, but the ZK artifact namespace is shared
 * (`/predicate-zk/<circuit>.{bzkir,prover,verifier}`).
 *
 * The heavy `.bzkir`/`.prover`/`.verifier` artifacts are fetched lazily
 * through the same layered cache the Groth16 keys use (in-memory →
 * IndexedDB → immutable HTTP). Only the small compactc-generated ABI
 * modules are bundled (`./contracts/<kind>`).
 */

import {
  ZKConfigProvider,
  createProverKey,
  createVerifierKey,
  createZKIR,
} from '@midnight-ntwrk/midnight-js-types'
import type { ProverKey, VerifierKey, ZKIR } from '@midnight-ntwrk/midnight-js-types'
import type { createCallTxOptions } from '@midnight-ntwrk/midnight-js-contracts'
import { getRegistryApi } from '@owlid/verifier-client'

import type { PredicateKind, PredicateWitness } from './kinds.js'
import { buildCompiledContract } from './witnesses.js'

export type { PredicateKind, PredicateWitness } from './kinds.js'
export { PREDICATE_KINDS } from './kinds.js'

// ---------------------------------------------------------------------------
// Asset interface consumed by the orchestrator
// ---------------------------------------------------------------------------

/**
 * Per-kind compiled contract + shared zkConfig provider. The browser
 * and node wirings supply concrete implementations; the orchestrator
 * stays free of asset/bundling concerns.
 */
export interface PredicateAssets {
  /** Compile the kind-specific contract with `witness` bound. */
  compiledContract(
    kind: PredicateKind,
    witness: PredicateWitness,
  ): Parameters<typeof createCallTxOptions>[0]
  /** zkir + proving/verifier keys for every predicate circuit, served
   *  over the verification-service `/predicate-zk` endpoint. */
  zkConfigProvider: ZKConfigProvider<string>
}

/** Optional overrides (tests / custom CDN). Internal — not a public knob. */
export interface PredicateAssetsOptions {
  /** Custom artifact loader (e.g. Node filesystem in tests). Bypasses the
   *  generated-client + IndexedDB path entirely. */
  loader?: (filename: string) => Promise<Uint8Array>
  /** Persist fetched artifacts in IndexedDB. Default `true`; browsers in
   *  private mode or non-DOM runtimes silently fall back to HTTP cache. */
  cache?: boolean
}

// ---------------------------------------------------------------------------
// zkConfigProvider over the verifier-service /predicate-zk endpoint
// ---------------------------------------------------------------------------

const DB_NAME = 'owlid-predicate-zk'
const STORE_NAME = 'artifacts'
const DB_VERSION = 1

/**
 * `ZKConfigProvider` that streams every predicate Compact artifact
 * through the generated `@owlid/verifier-client` `RegistryApi`
 * (`/predicate-zk` — auto-configured from `@owlid/config`, the same
 * endpoint/credentials as `OwlVerifier`; never a raw fetch). Mirrors
 * `NodeZkConfigProvider` (`<circuit>.bzkir` / `.prover` / `.verifier`)
 * but with a layered cache so the multi-MB pull happens at most once
 * per device per circuit.
 */
class FetchZkConfigProvider extends ZKConfigProvider<string> {
  private readonly loader?: (filename: string) => Promise<Uint8Array>
  private readonly cache: boolean
  private readonly mem = new Map<string, Uint8Array>()
  private readonly inflight = new Map<string, Promise<Uint8Array>>()

  constructor(opts: PredicateAssetsOptions = {}) {
    super()
    this.loader = opts.loader
    this.cache = opts.cache ?? true
  }

  async getProverKey(circuitId: string): Promise<ProverKey> {
    return createProverKey(await this.artifact(circuitId, 'prover'))
  }

  async getVerifierKey(circuitId: string): Promise<VerifierKey> {
    return createVerifierKey(await this.artifact(circuitId, 'verifier'))
  }

  async getZKIR(circuitId: string): Promise<ZKIR> {
    return createZKIR(await this.artifact(circuitId, 'bzkir'))
  }

  private artifact(circuitId: string, kind: 'bzkir' | 'prover' | 'verifier'): Promise<Uint8Array> {
    const filename = `${circuitId}.${kind}`
    const mem = this.mem.get(filename)
    if (mem) return Promise.resolve(mem)
    const existing = this.inflight.get(filename)
    if (existing) return existing
    const p = this.load(filename).finally(() => this.inflight.delete(filename))
    this.inflight.set(filename, p)
    return p
  }

  private async load(filename: string): Promise<Uint8Array> {
    if (this.cache && !this.loader) {
      const cached = await readIdb(filename).catch(() => null)
      if (cached) {
        this.mem.set(filename, cached)
        return cached
      }
    }
    const bytes = this.loader ? await this.loader(filename) : await this.fetch(filename)
    this.mem.set(filename, bytes)
    if (this.cache && !this.loader) {
      // Best-effort persist; a missing IndexedDB just means a refetch
      // next session (the endpoint is immutable-cached by HTTP anyway).
      writeIdb(filename, bytes).catch(() => {})
    }
    return bytes
  }

  private async fetch(filename: string): Promise<Uint8Array> {
    // The generated client owns the endpoint, base URL, and credentials
    // (the SDK is the only dev surface — no raw fetch, no sidecar). The
    // artifact route has no JSON body schema (raw octet-stream, same as
    // `/zk-keys`), so the typed method resolves `void`; read the bytes
    // off the underlying response via the `…Raw` variant.
    const res = await getRegistryApi().getPredicateAssetRaw({ filename })
    return new Uint8Array(await res.raw.arrayBuffer())
  }
}

// ---------------------------------------------------------------------------
// IndexedDB helpers (own DB so the predicate artifact keyspace never
// collides with the Groth16 `owlid-zk-keys` store)
// ---------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function readIdb(filename: string): Promise<Uint8Array | null> {
  const db = await openDb()
  try {
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(filename)
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

async function writeIdb(filename: string, bytes: Uint8Array): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(bytes, filename)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// Factory consumed by the orchestrator
// ---------------------------------------------------------------------------

/**
 * Build the concrete `PredicateAssets` for the running platform. The
 * orchestrator calls `compiledContract(kind, witness)` once per
 * predicate (kind chosen by DCQL routing, witness derived from the
 * credential) and shares the one `zkConfigProvider` across all of them.
 */
export function createPredicateAssets(opts?: PredicateAssetsOptions): PredicateAssets {
  const zkConfigProvider = new FetchZkConfigProvider(opts)
  return {
    compiledContract: (kind, witness) => buildCompiledContract(kind, witness),
    zkConfigProvider,
  }
}
