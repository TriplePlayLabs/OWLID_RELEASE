/**
 * Predicate Registry routes — Midnight-native ZK attestations.
 *
 * One Compact contract per predicate (one address per kind), kept under
 * Midnight's per-extrinsic deploy-weight cap. The route surface is
 * uniform: every route takes `:kind` so the caller picks which
 * predicate contract to act on.
 *
 * Two paths:
 *   - Legacy sidecar-side attest: holder POSTs raw witness; sidecar
 *     proves + submits. Witness reaches the sidecar.
 *   - Holder-device prove-without-submit: holder fetches `/snapshot`,
 *     proves the circuit locally (zkir-v2 WASM, witness never leaves
 *     device), POSTs the proven, unsubmitted tx to `/relay`. The
 *     sidecar balances + submits without ever seeing the witness.
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getClient, hexToBytes } from '../client.js'
import { PREDICATE_KINDS, type PredicateKind } from '../config.js'
import { eventBus, type SidecarEvent } from '../events.js'
// `@owlid/sdk/midnight` is the advanced predicate-proving subpath
// for callers running their own Midnight relay. The top-level
// `@owlid/sdk` barrel stays free of Midnight-specific types so
// application code only sees OwlVerifier / OwlWallet / Predicates.
import {
  buildAllowedSetTree,
  findPathForCountry,
  treeRootBytesLE,
  type MerkleTreePath,
} from '@owlid/sdk/midnight'

const predicates = new Hono()

function parseKind(raw: string): PredicateKind {
  if (!(PREDICATE_KINDS as readonly string[]).includes(raw)) {
    throw new Error(`Unknown predicate kind '${raw}'. Valid kinds: ${PREDICATE_KINDS.join(', ')}`)
  }
  return raw as PredicateKind
}

/** POST /api/predicates/attest/age { rootHash, threshold, age } */
predicates.post('/attest/age', async (c) => {
  try {
    const { rootHash, threshold, age } = await c.req.json<{
      rootHash: string
      threshold: number
      age: number
    }>()
    await getClient().attestAge(hexToBytes(rootHash), threshold, age)
    return c.json({ success: true, predicate: 'age', rootHash, threshold })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

/** POST /api/predicates/attest/kyc { rootHash, threshold, kycLevel } */
predicates.post('/attest/kyc', async (c) => {
  try {
    const { rootHash, threshold, kycLevel } = await c.req.json<{
      rootHash: string
      threshold: number
      kycLevel: number
    }>()
    await getClient().attestKyc(hexToBytes(rootHash), threshold, kycLevel)
    return c.json({ success: true, predicate: 'kyc', rootHash, threshold })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

/** POST /api/predicates/attest/nationality
 *    { rootHash, countryCode, allowedCountries, verifierId }
 *  All set / verifier data is private — only `setHash` lands on chain. */
predicates.post('/attest/nationality', async (c) => {
  try {
    const { rootHash, countryCode, allowedCountries, verifierId } = await c.req.json<{
      rootHash: string
      countryCode: string
      allowedCountries: string[]
      verifierId: string
    }>()
    const { code, path, verifierIdHash, setHash } = await buildSetMembership(
      countryCode,
      allowedCountries,
      verifierId,
    )
    await getClient().attestNationality(hexToBytes(rootHash), code, path, verifierIdHash, setHash)
    return c.json({ success: true, predicate: 'nationality', rootHash })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

/** POST /api/predicates/attest/residency
 *    { rootHash, countryCode, allowedCountries, verifierId } */
predicates.post('/attest/residency', async (c) => {
  try {
    const { rootHash, countryCode, allowedCountries, verifierId } = await c.req.json<{
      rootHash: string
      countryCode: string
      allowedCountries: string[]
      verifierId: string
    }>()
    const { code, path, verifierIdHash, setHash } = await buildSetMembership(
      countryCode,
      allowedCountries,
      verifierId,
    )
    await getClient().attestResidency(hexToBytes(rootHash), code, path, verifierIdHash, setHash)
    return c.json({ success: true, predicate: 'residency', rootHash })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

/** Right-pad a 2-letter ISO 3166-1 alpha-2 country code into a 32-byte
 *  slot, matching Compact `pad(32, "NL")`. */
function padCountry(code: string): Uint8Array {
  const upper = code.trim().toUpperCase()
  if (upper.length !== 2 || !/^[A-Z]{2}$/.test(upper)) {
    throw new Error(`country must be ISO 3166-1 alpha-2: got "${code}"`)
  }
  const out = new Uint8Array(32)
  out.set(new TextEncoder().encode(upper))
  return out
}

/** Build every artefact the Compact set-membership circuits need from
 *  the holder's plain inputs (country, list, verifier id). Uses the
 *  shared SDK Merkle builder so the off-chain root + path match the
 *  in-circuit reconstruction one-to-one. */
async function buildSetMembership(
  countryCode: string,
  allowedCountries: string[],
  verifierId: string,
): Promise<{
  code: Uint8Array
  path: MerkleTreePath<Uint8Array>
  verifierIdHash: Uint8Array
  setHash: Uint8Array
}> {
  if (!verifierId || typeof verifierId !== 'string') {
    throw new Error('verifierId required (per-verifier salt for setHash)')
  }
  const code = padCountry(countryCode)
  const built = buildAllowedSetTree(allowedCountries)
  const upper = countryCode.toUpperCase()
  const path = findPathForCountry(built, upper)
  const rootBytes = treeRootBytesLE(built.tree)
  const verifierIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifierId)),
  )
  const outer = new Uint8Array(64)
  outer.set(verifierIdHash, 0)
  outer.set(rootBytes, 32)
  const setHash = new Uint8Array(await crypto.subtle.digest('SHA-256', outer))
  return { code, path, verifierIdHash, setHash }
}

/** POST /api/predicates/attest/email { rootHash, flag } */
predicates.post('/attest/email', async (c) => {
  try {
    const { rootHash, flag } = await c.req.json<{ rootHash: string; flag: number }>()
    await getClient().attestEmailVerified(hexToBytes(rootHash), flag)
    return c.json({ success: true, predicate: 'email', rootHash })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

/** POST /api/predicates/attest/age-range { rootHash, minAge, maxAge, age } */
predicates.post('/attest/age-range', async (c) => {
  try {
    const { rootHash, minAge, maxAge, age } = await c.req.json<{
      rootHash: string
      minAge: number
      maxAge: number
      age: number
    }>()
    await getClient().attestAgeRange(hexToBytes(rootHash), minAge, maxAge, age)
    return c.json({ success: true, predicate: 'age_range', rootHash, minAge, maxAge })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

/** POST /api/predicates/attest/personhood { rootHash, epoch, appId, personhoodSecret } */
predicates.post('/attest/personhood', async (c) => {
  try {
    const { rootHash, epoch, appId, personhoodSecret } = await c.req.json<{
      rootHash: string
      epoch: string
      appId: string
      personhoodSecret: string
    }>()
    await getClient().attestUniquePersonhood(
      hexToBytes(rootHash),
      hexToBytes(epoch),
      hexToBytes(appId),
      hexToBytes(personhoodSecret),
    )
    return c.json({ success: true, predicate: 'personhood', rootHash })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

// `seed-nationality` was an owner-only extrinsic for the old
// owner-seeded `approvedNationality` Merkle set. Under the new
// verifier-supplied-set model the contract has no global policy to
// seed — the route is gone.

/** GET /api/predicates/:kind/count — attestations Set size for this kind */
predicates.get('/:kind/count', (c) => {
  try {
    const kind = parseKind(c.req.param('kind'))
    return c.json({ kind, attestCount: getClient().predicateAttestCount(kind).toString() })
  } catch (e) {
    return c.json({ error: String(e) }, 400)
  }
})

/** GET /api/predicates/:kind/:key/attested — membership check on the
 *  kind's Set for a precomputed key (hex). */
predicates.get('/:kind/:key/attested', (c) => {
  try {
    const kind = parseKind(c.req.param('kind'))
    const key = c.req.param('key')
    return c.json({ kind, key, attested: getClient().isAttestedFromLedger(kind, hexToBytes(key)) })
  } catch (e) {
    return c.json({ error: String(e) }, 400)
  }
})

// ---------------------------------------------------------------------------
// Holder-device prove-without-submit split.
// ---------------------------------------------------------------------------

/** GET /api/predicates/:kind/snapshot — off-chain state for holder
 *  proving against the kind's contract. */
predicates.get('/:kind/snapshot', async (c) => {
  try {
    const kind = parseKind(c.req.param('kind'))
    return c.json(await getClient().snapshotPredicate(kind))
  } catch (e) {
    return c.json({ error: String(e) }, 400)
  }
})

/** POST /api/predicates/:kind/relay { provenTx } — accept a
 *  holder-proven UnboundTransaction (hex) and return a job-id in ≤10
 *  ms. `balanceTx` + `submitTx` run in the background; the holder polls
 *  `GET /api/predicates/tx/:txId/status` (using the returned job-id) to
 *  learn the current phase (`queued | balancing | submitting`) and,
 *  once the chain accepts the tx, the terminal finalization status.
 *  Witness already stripped before the wire — the sidecar never sees it. */
predicates.post('/:kind/relay', async (c) => {
  try {
    const kind = parseKind(c.req.param('kind'))
    const { provenTx } = await c.req.json<{ provenTx: string }>()
    if (!provenTx) return c.json({ error: 'provenTx required' }, 400)
    // `relayProvenTx` is synchronous and never awaits any wallet or
    // chain state: it returns the job-id immediately.
    return c.json(getClient().relayProvenTx(kind, provenTx))
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

// Terminal phase sets, shared by the two SSE routes below.
const TERMINAL_JOB = new Set(['balance-failed', 'submit-failed'])
const TERMINAL_CHAIN = new Set(['SucceedEntirely', 'FailEntirely', 'FailFallible'])

/** Shared SSE-write helpers. The two transports (WS for two-way
 *  channels, SSE for server→client) are fixed at the system level;
 *  every status update goes out as `event: status` with a JSON
 *  `{txId, status, error?}` payload, terminated by either a terminal
 *  job phase or a terminal chain status. */
type SSEStream = Parameters<Parameters<typeof streamSSE>[1]>[0]
function makeWriter(stream: SSEStream): {
  writeStatus: (txId: string, status: string, error?: string) => Promise<void>
  startKeepAlive: () => () => void
} {
  let id = 0
  return {
    writeStatus: async (txId, status, error) => {
      await stream.writeSSE({
        id: String(++id),
        event: 'status',
        data: JSON.stringify({ txId, status, error }),
      })
    },
    startKeepAlive: () => {
      // Keep-alive every 10 s so Cloud Run / GFE edge proxies see
      // bytes flowing and don't kill the stream as idle. The Cloud
      // Run request timeout (900 s) still applies as a hard upper
      // bound; the client reconnects on disconnect.
      const timer = setInterval(() => {
        void stream.writeSSE({ event: 'ping', data: '{}' })
      }, 10_000)
      return () => clearInterval(timer)
    },
  }
}

/** GET /api/predicates/job/:jobId/events — SSE stream of phase
 *  transitions for a relay job. Drives via the in-process eventBus
 *  through `queued → balancing → submitting → submitted`, then
 *  switches to the chain-side wait via `watchForTxData`. Terminates
 *  on terminal job phase (`balance-failed | submit-failed`) or
 *  terminal chain status (`SucceedEntirely | FailEntirely |
 *  FailFallible`). The client closes its EventSource on terminal.
 *
 *  Use this endpoint for ids returned by `/predicates/{kind}/relay`. */
predicates.get('/job/:jobId/events', (c) => {
  const jobId = c.req.param('jobId')
  if (!jobId) return c.json({ error: 'jobId required' }, 400)
  return streamSSE(c, async (stream) => {
    const { writeStatus, startKeepAlive } = makeWriter(stream)
    const stopKeepAlive = startKeepAlive()
    let unsubscribe: (() => void) | null = null
    stream.onAbort(() => {
      stopKeepAlive()
      unsubscribe?.()
    })
    try {
      const client = getClient()
      const job = client.getRelayJob(jobId)
      // Job not found — most likely the sidecar restarted between
      // `/relay` accepting the request and the holder opening this
      // SSE (the `relayJobs` map is in-memory). Job-id and chain
      // tx-id are both 32-byte hex; fall back to treating the id as
      // a chain tx-id and waiting on indexer finalization directly.
      // `watchForTxData` is idempotent: if the chain knows the tx
      // it'll resolve quickly, if it doesn't it'll keep polling
      // until our timeout / the caller aborts. Either way the
      // client sees ONE terminal status and stops — no reconnect
      // loop.
      if (!job) {
        const finalized = await client.awaitChainStatus(jobId)
        await writeStatus(jobId, finalized)
        return
      }
      await writeStatus(job.jobId, job.phase, job.error)
      if (TERMINAL_JOB.has(job.phase)) return
      let chainTxId: string | null = job.chainTxId ?? null
      if (chainTxId === null) {
        chainTxId = await new Promise<string | null>((resolve) => {
          unsubscribe = eventBus.subscribe((event: SidecarEvent) => {
            if (event.type !== 'relay') return
            if (event.jobId !== job.jobId) return
            void writeStatus(job.jobId, event.phase, event.error)
            if (TERMINAL_JOB.has(event.phase)) {
              unsubscribe?.()
              resolve(null)
              return
            }
            if (event.phase === 'submitted' && event.txId) {
              unsubscribe?.()
              resolve(event.txId)
            }
          })
        })
        if (chainTxId === null) return
      }
      const finalized = await client.awaitChainStatus(chainTxId)
      await writeStatus(chainTxId, finalized)
      void TERMINAL_CHAIN
    } catch (e) {
      // Degraded sidecar (mid-resync: `getClient()` throws) or any
      // unexpected stream error. Emit a TERMINAL status frame rather
      // than `event: 'error'`: the client treats `unknown` as terminal
      // and stops cleanly, instead of reconnecting into a still-degraded
      // sidecar (the observed 375-request storm). The holder sees one
      // failed predicate with a clear reason, not a hang.
      await writeStatus(jobId, 'unknown', String(e))
    }
  })
})

export { predicates }
