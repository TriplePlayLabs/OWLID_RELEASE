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

/** GET /api/predicates/tx/:txId/events — SSE stream of phase
 *  transitions for a relay job (or raw chain tx). The system uses
 *  exactly two notification transports end-to-end: WS for two-way
 *  channels (presentation sockets) and SSE for server→client pushes.
 *  No polling.
 *
 *  Lifecycle:
 *    1. Emit a `status` SSE event with the current snapshot so a
 *       late subscriber catches up to the latest known state.
 *    2. If the job is still in-flight (`queued|balancing|submitting`),
 *       tail the in-process eventBus for `relay` events matching the
 *       jobId. Each transition is one SSE event.
 *    3. Once the job reaches `submitted` with a real chain `txId`,
 *       await `watchForTxData` (an indexer WebSocket subscription —
 *       also push, not poll) and emit ONE final SSE event with the
 *       terminal chain status.
 *    4. On terminal status (`SucceedEntirely | FailEntirely |
 *       FailFallible | balance-failed | submit-failed`) the server
 *       closes the stream. The client closes its EventSource. */
predicates.get('/tx/:txId/events', (c) => {
  const idOrJobId = c.req.param('txId')
  if (!idOrJobId) return c.json({ error: 'txId required' }, 400)
  return streamSSE(c, async (stream) => {
    let id = 0
    const writeStatus = async (txId: string, status: string, error?: string): Promise<void> => {
      await stream.writeSSE({
        id: String(++id),
        event: 'status',
        data: JSON.stringify({ txId, status, error }),
      })
    }
    const TERMINAL_JOB = new Set(['balance-failed', 'submit-failed'])
    const TERMINAL_CHAIN = new Set(['SucceedEntirely', 'FailEntirely', 'FailFallible'])

    // Keep-alive every 10 s so Cloud Run / GFE edge proxies see
    // bytes flowing and don't kill the stream as idle. The Cloud Run
    // request timeout (900 s) still applies as a hard upper bound;
    // the client reconnects on disconnect, so an actual idle-cap kill
    // is recovered transparently.
    const keepAlive = setInterval(() => {
      void stream.writeSSE({ event: 'ping', data: '{}' })
    }, 10_000)
    let unsubscribe: (() => void) | null = null
    stream.onAbort(() => {
      clearInterval(keepAlive)
      unsubscribe?.()
    })

    try {
      const client = getClient()
      // 1. Snapshot the current job (if any) so a late subscriber
      //    catches up. If there is no job entry, treat the caller's
      //    id as a raw chain tx-id and skip straight to step 3.
      const job = client.getRelayJob(idOrJobId)
      let chainTxId: string | null = null
      if (job) {
        await writeStatus(job.jobId, job.phase, job.error)
        if (TERMINAL_JOB.has(job.phase)) {
          return // stream ends naturally
        }
        if (job.phase === 'submitted' && job.txId) {
          chainTxId = job.txId
        } else {
          // 2. Wait for the bus emission that flips us into `submitted`
          //    (or a terminal failure). After that, switch to watching
          //    the chain.
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
      } else {
        // Raw chain tx-id path: emit an immediate `pending` snapshot
        // so the client knows the connection is alive without waiting
        // for the 10 s keep-alive ping or chain finalization.
        chainTxId = idOrJobId
        await writeStatus(chainTxId, 'pending')
      }
      // 3. Single push wait on the indexer WS. No retry loop, no
      //    interval timer — watchForTxData resolves exactly once
      //    when the indexer observes the tx.
      const finalized = await client.awaitChainStatus(chainTxId)
      await writeStatus(chainTxId, finalized)
      if (!TERMINAL_CHAIN.has(finalized) && finalized !== 'unknown') {
        // Unexpected non-terminal status — emit and close so the
        // client treats it as terminal rather than waiting forever.
        // (`watchForTxData` is documented to resolve only on
        //  finalization, so we shouldn't reach here in practice.)
      }
    } catch (e) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ message: String(e) }),
      })
    }
  })
})

export { predicates }
