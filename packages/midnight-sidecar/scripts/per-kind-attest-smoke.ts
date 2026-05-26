#!/usr/bin/env bun
/**
 * Per-kind predicate attestation smoke.
 *
 * Exercises the new Phase C split end-to-end against the live local
 * devnet: holder fetches the snapshot from verification-service →
 * proves the per-kind attestation circuit locally (zkir-v2 WASM, in
 * process) → POSTs the proven (witness-stripped) tx back to
 * verification-service → sidecar balances + submits → SSE mirror
 * surfaces the attestation key → verification-service confirms
 * membership.
 *
 * Targets a single predicate via `--kind=<age|kyc|residency|email|
 * nationality>` (default: email — smallest path, no Merkle witness).
 *
 * Pre-reqs: full stack up (`docker compose` services + sidecar :3000
 * + verification-service :8000). Reads `API_KEY_DEV` and the per-kind
 * MIDNIGHT_PREDICATE_<KIND>_ADDRESS out of the root .env.
 *
 * Run from repo root:
 *   bun --env-file=.env run packages/midnight-sidecar/scripts/per-kind-attest-smoke.ts --kind=email
 */

import { CompiledContract } from '@midnight-ntwrk/compact-js'
import { Bytes32Descriptor, persistentHash } from '@midnight-ntwrk/compact-runtime'
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider'
import { setNetworkId, NetworkId } from '@midnight-ntwrk/midnight-js-network-id'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

// The midnight-js stack reads a process-global network id during
// circuit-exec — set it before anything else touches it.
setNetworkId((process.env.MIDNIGHT_NETWORK_ID ?? 'undeployed') as NetworkId)

import { proveAttestationUnsubmitted } from '../../sdk/dist/midnight/prove.js'
import type { PredicateSnapshot } from '../../sdk/dist/midnight/snapshot.js'

type Kind = 'age' | 'kyc' | 'residency' | 'email' | 'nationality'

interface KindSpec {
  envAddr: string
  managedDir: string
  contractModule: string
  circuitId: string
  // Witness factory (the value the holder proves). Receives the parsed
  // ledger so nationality can derive its Merkle path.
  witnesses: (ledger: unknown) => Record<string, unknown>
  // Public args for the attest* circuit.
  args: (root: Uint8Array) => unknown[]
  // Pre-computed attestation key for the on-chain membership probe.
  attestKey: (root: Uint8Array) => string
  // Predicate name the verifier's /predicates/attested endpoint uses
  // (the predicate-attestation namespace, not the URL kind).
  predicateName: string
  threshold?: number
}

const ROOT = new Uint8Array(32).fill(0xc3)

function leftPad32(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s)
  if (bytes.length > 32) throw new Error(`tag ${s} > 32 bytes`)
  const out = new Uint8Array(32)
  out.set(bytes, 0)
  return out
}

function u128LE32(n: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let v = n
  for (let i = 0; i < 32 && v > 0n; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

function sha256Hex(...chunks: Uint8Array[]): string {
  const h = createHash('sha256')
  for (const c of chunks) h.update(c)
  return h.digest('hex')
}

const SPECS: Record<Kind, KindSpec> = {
  email: {
    envAddr: 'MIDNIGHT_PREDICATE_EMAIL_ADDRESS',
    managedDir: 'predicate_email',
    contractModule: '../managed/predicate_email/contract/index.js',
    circuitId: 'attestEmailVerified',
    witnesses: () => ({
      emailVerifiedFlag: (ctx: { privateState: unknown }) => [ctx.privateState, 1n],
    }),
    args: (root) => [root],
    attestKey: (root) => sha256Hex(leftPad32('owlid:attest:email:'), root, new Uint8Array(32)),
    predicateName: 'email_verified',
  },
  age: {
    envAddr: 'MIDNIGHT_PREDICATE_AGE_ADDRESS',
    managedDir: 'predicate_age',
    contractModule: '../managed/predicate_age/contract/index.js',
    circuitId: 'attestAgeGte',
    witnesses: () => ({
      ageValue: (ctx: { privateState: unknown }) => [ctx.privateState, 30n],
    }),
    args: (root) => [root, 18n],
    attestKey: (root) => sha256Hex(leftPad32('owlid:attest:age:'), root, u128LE32(18n)),
    predicateName: 'age',
    threshold: 18,
  },
  kyc: {
    envAddr: 'MIDNIGHT_PREDICATE_KYC_ADDRESS',
    managedDir: 'predicate_kyc',
    contractModule: '../managed/predicate_kyc/contract/index.js',
    circuitId: 'attestKycGte',
    witnesses: () => ({
      kycLevel: (ctx: { privateState: unknown }) => [ctx.privateState, 3n],
    }),
    args: (root) => [root, 2n],
    attestKey: (root) => sha256Hex(leftPad32('owlid:attest:kyc:'), root, u128LE32(2n)),
    predicateName: 'kyc',
    threshold: 2,
  },
  residency: {
    envAddr: 'MIDNIGHT_PREDICATE_RESIDENCY_ADDRESS',
    managedDir: 'predicate_residency',
    contractModule: '../managed/predicate_residency/contract/index.js',
    circuitId: 'attestResidency',
    witnesses: () => ({
      residencyValue: (ctx: { privateState: unknown }) => [ctx.privateState, 1n],
    }),
    args: (root) => [root],
    attestKey: (root) => sha256Hex(leftPad32('owlid:attest:res:'), root, new Uint8Array(32)),
    predicateName: 'residency',
  },
  nationality: {
    envAddr: 'MIDNIGHT_PREDICATE_NATIONALITY_ADDRESS',
    managedDir: 'predicate_nationality',
    contractModule: '../managed/predicate_nationality/contract/index.js',
    circuitId: 'attestNationalityIn',
    witnesses: () => ({
      nationalityPath: (ctx: { privateState: unknown; ledger: unknown }) => {
        const leaf = persistentHash(Bytes32Descriptor, new TextEncoder().encode('DE'))
        const ledger = ctx.ledger as {
          approvedNationality: { findPathForLeaf(l: Uint8Array): unknown }
        }
        const path = ledger.approvedNationality.findPathForLeaf(leaf)
        if (!path) throw new Error('DE not seeded in approvedNationality')
        return [ctx.privateState, path]
      },
    }),
    args: (root) => [root],
    attestKey: (root) => sha256Hex(leftPad32('owlid:attest:nat:'), root, new Uint8Array(32)),
    predicateName: 'nationality',
  },
}

function parseKind(): Kind {
  const arg = process.argv.find((a) => a.startsWith('--kind='))
  const raw = arg ? arg.slice('--kind='.length) : 'email'
  if (!(raw in SPECS)) throw new Error(`--kind must be one of ${Object.keys(SPECS).join(', ')}`)
  return raw as Kind
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
}

function hexToBytes(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error(`hex length ${s.length} not even`)
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16)
  return out
}

async function main(): Promise<void> {
  const kind = parseKind()
  const spec = SPECS[kind]
  const verifyUrl = process.env.VERIFICATION_SERVICE_URL ?? 'http://localhost:8000'
  const apiKey = process.env.API_KEY_DEV
  if (!apiKey) throw new Error('API_KEY_DEV missing (source .env)')
  const sidecarUrl = process.env.MIDNIGHT_SIDECAR_URL ?? 'http://localhost:3000'
  const sidecarKey = process.env.MIDNIGHT_SIDECAR_API_KEY
  if (!sidecarKey) throw new Error('MIDNIGHT_SIDECAR_API_KEY missing (source .env)')
  const addr = process.env[spec.envAddr]
  if (!addr) throw new Error(`${spec.envAddr} missing`)
  const base = join(import.meta.dir, '..', 'managed')

  console.log(`=== per-kind smoke: ${kind} ===`)
  console.log(`contract ${addr} root=${bytesToHex(ROOT)}`)

  // ----- 1. snapshot via verification-service -----
  const snapResp = await fetch(`${verifyUrl}/predicates/${kind}/snapshot`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!snapResp.ok) {
    throw new Error(`snapshot fetch failed: ${snapResp.status} ${await snapResp.text()}`)
  }
  const snapshot = (await snapResp.json()) as PredicateSnapshot
  console.log(
    `[1] snapshot {address=${snapshot.address.slice(0, 16)}… zswap=${snapshot.zswapChainState.length / 2}B contract=${
      snapshot.contractState.length / 2
    }B params=${snapshot.ledgerParameters.length / 2}B}`,
  )
  if (snapshot.address !== addr) {
    throw new Error(`snapshot address ${snapshot.address} != expected ${addr}`)
  }

  // ----- 2. compile contract w/ witness, prove locally -----
  const contractMod = await import(spec.contractModule)
  const ContractClass = contractMod.Contract
  const zk = new NodeZkConfigProvider(join(base, spec.managedDir))

  // Nationality needs the on-chain Merkle ledger to find the path — peek
  // it from the snapshot's ContractState ledger() before we hand the
  // compiled contract off.
  let dummyLedger: unknown = {}
  if (kind === 'nationality') {
    // The ledger isn't easily peekable here without the runtime — but
    // CompiledContract's witness closure receives `ctx.ledger` from
    // createUnprovenCallTx itself, so we just pass the witness factory
    // through and trust the snapshot-backed provider feeds it.
    dummyLedger = {}
  }
  const witnesses = spec.witnesses(dummyLedger)
  const compiled = CompiledContract.make(`predicate-${kind}`, ContractClass).pipe(
    CompiledContract.withWitnesses(witnesses as never) as never,
    CompiledContract.withCompiledFileAssets(join(base, spec.managedDir)) as never,
  )

  console.log(`[2] proving ${spec.circuitId} on device (zkir-v2 wasm)…`)
  const t0 = Date.now()
  const provenTx = await proveAttestationUnsubmitted({
    compiledContract: compiled as never,
    zkConfigProvider: zk as never,
    snapshot,
    circuitId: spec.circuitId,
    args: spec.args(ROOT),
    privateStateId: `owlid-predicate-${kind}`,
  })
  console.log(`[2]   proven tx ${provenTx.length}B ${Date.now() - t0}ms`)

  // ----- 3. relay to verification-service -----
  const t1 = Date.now()
  const relayResp = await fetch(`${verifyUrl}/predicates/${kind}/relay`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ provenTx: bytesToHex(provenTx) }),
  })
  if (!relayResp.ok) {
    throw new Error(`relay failed: ${relayResp.status} ${await relayResp.text()}`)
  }
  const relay = (await relayResp.json()) as { txId: string; status: string }
  console.log(
    `[3] relayed txId=${relay.txId.slice(0, 24)}… status=${relay.status} ${Date.now() - t1}ms`,
  )
  if (relay.status !== 'SucceedEntirely') {
    throw new Error(`relay status ${relay.status}`)
  }

  // ----- 4. verifier-side membership check -----
  // Re-derive the key off-chain so we can also probe the sidecar
  // directly, then ask verification-service for membership.
  const key = spec.attestKey(ROOT)
  const sidecarResp = await fetch(`${sidecarUrl}/api/predicates/${kind}/${key}/attested`, {
    headers: { Authorization: `Bearer ${sidecarKey}` },
  })
  const sidecarJson = (await sidecarResp.json()) as { attested?: boolean }
  console.log(`[4a] sidecar membership(${key.slice(0, 16)}…) = ${sidecarJson.attested}`)

  const checkResp = await fetch(`${verifyUrl}/predicates/attested`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      credentialId: bytesToHex(ROOT),
      predicate: spec.predicateName,
      threshold: spec.threshold,
    }),
  })
  const check = (await checkResp.json()) as { attested: boolean; attestKey: string }
  console.log(
    `[4b] verify-service attested=${check.attested} (recomputed key=${check.attestKey.slice(0, 16)}…)`,
  )
  if (!check.attested || !sidecarJson.attested) {
    throw new Error('attestation not visible after relay (chain not settled? sse lag?)')
  }
  if (check.attestKey !== key) {
    throw new Error(`key mismatch: off-chain=${key} verifier=${check.attestKey}`)
  }
  console.log(`\n✅ ${kind} smoke PASS`)
}

main().catch((e) => {
  console.error('\n❌ per-kind smoke failed:', e?.stack ?? e)
  process.exit(1)
})
