#!/usr/bin/env bun
/**
 * Relay-path concurrency load harness.
 *
 * Simulates N holders who each proved an `email_verified` attestation
 * on-device (in-memory WASM prove, distinct root per holder), then fires
 * all N proven txs at the sidecar's `/api/predicates/email/relay`
 * CONCURRENTLY. The relay is fire-and-forget, so the wallet balance+submit
 * pipeline runs in the background — measure it from the sidecar log's
 * `wallet.submit.reserved`/`broadcast.ok` events.
 *
 *   bun run scripts/relay-load.ts --n=6
 *
 * Reads MIDNIGHT_SIDECAR_API_KEY + MIDNIGHT_PREDICATE_EMAIL_ADDRESS +
 * MIDNIGHT_NETWORK_ID from the environment.
 */
import { CompiledContract } from '@midnight-ntwrk/compact-js'
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider'
import { setNetworkId, type NetworkId } from '@midnight-ntwrk/midnight-js-network-id'
import { join } from 'node:path'

setNetworkId((process.env.MIDNIGHT_NETWORK_ID ?? 'undeployed') as NetworkId)

import { proveAttestationUnsubmitted } from '../../sdk/dist/midnight/prove.js'
import type { PredicateSnapshot } from '../../sdk/dist/midnight/snapshot.js'

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
}

function rootFor(i: number): Uint8Array {
  // Distinct root per holder → distinct attestation key → independent tx.
  const r = new Uint8Array(32).fill(0xc3)
  r[0] = i & 0xff
  r[1] = (i >> 8) & 0xff
  return r
}

async function main() {
  const n = Number(process.argv.find((a) => a.startsWith('--n='))?.slice(4) ?? '6')
  const sidecar = process.env.MIDNIGHT_SIDECAR_URL ?? 'http://localhost:3000'
  const key = process.env.MIDNIGHT_SIDECAR_API_KEY
  const addr = process.env.MIDNIGHT_PREDICATE_EMAIL_ADDRESS
  if (!key || !addr)
    throw new Error('MIDNIGHT_SIDECAR_API_KEY / MIDNIGHT_PREDICATE_EMAIL_ADDRESS missing')
  const auth = { Authorization: `Bearer ${key}` }

  console.log(`=== relay load: kind=email N=${n} ===`)

  // 1. One snapshot for all (distinct keys → no contract-state conflict).
  const snapResp = await fetch(`${sidecar}/api/predicates/email/snapshot`, { headers: auth })
  if (!snapResp.ok) throw new Error(`snapshot ${snapResp.status}: ${await snapResp.text()}`)
  const snapshot = (await snapResp.json()) as PredicateSnapshot

  // 2. Compile once.
  const base = join(import.meta.dir, '..', 'managed')
  const contractMod = await import('../managed/predicate_email/contract/index.js')
  const zk = new NodeZkConfigProvider(join(base, 'predicate_email'))
  const compiled = CompiledContract.make('predicate-email', contractMod.Contract).pipe(
    CompiledContract.withWitnesses({
      emailVerifiedFlag: (ctx: { privateState: unknown }) => [ctx.privateState, 1n],
    } as never) as never,
    CompiledContract.withCompiledFileAssets(join(base, 'predicate_email')) as never,
  )

  // 3. Pre-generate N proven txs serially (each = one holder's on-device prove).
  const proven: string[] = []
  for (let i = 0; i < n; i++) {
    const t0 = Date.now()
    const tx = await proveAttestationUnsubmitted({
      compiledContract: compiled as never,
      zkConfigProvider: zk as never,
      snapshot,
      circuitId: 'attestEmailVerified',
      args: [rootFor(i)],
      privateStateId: 'owlid-predicate-email',
    })
    proven.push(bytesToHex(tx))
    console.log(`  proved #${i} ${tx.length}B in ${Date.now() - t0}ms`)
  }

  // 4. Fire all N relays CONCURRENTLY.
  console.log(`\n--- firing ${n} concurrent relays ---`)
  const fired = Date.now()
  const results = await Promise.all(
    proven.map(async (hex, i) => {
      const t0 = Date.now()
      try {
        const r = await fetch(`${sidecar}/api/predicates/email/relay`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ provenTx: hex }),
        })
        const body = (await r.json()) as { jobId?: string; status?: string; error?: string }
        return { i, ms: Date.now() - t0, ...body }
      } catch (e) {
        return { i, ms: Date.now() - t0, error: String(e) }
      }
    }),
  )
  const dispatchSpan = Date.now() - fired
  for (const r of results) {
    console.log(
      `  relay #${r.i}: ${r.ms}ms  job=${r.jobId?.slice(0, 16) ?? '-'} status=${r.status ?? r.error}`,
    )
  }
  const returns = results.map((r) => r.ms)
  console.log(`\nrelay-return latency: min=${Math.min(...returns)}ms max=${Math.max(...returns)}ms`)
  console.log(`all ${n} dispatched within ${dispatchSpan}ms`)
  console.log(`errors: ${results.filter((r) => r.error || !r.jobId).length}/${n}`)
  console.log(
    `jobIds: ${results
      .map((r) => r.jobId)
      .filter(Boolean)
      .join(',')}`,
  )
  console.log('\nNow grep the sidecar log for wallet.submit.* / relay.* timing of these jobs.')
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
