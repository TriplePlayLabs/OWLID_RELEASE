// Live F-1 forge sweep — all 7 owl_root-bound predicates against the deployed
// contracts. For each predicate:
//   LEGIT : witness = the value the issuer committed under owl_root + the real
//           Merkle path → proof generates and the Midnight node records the
//           attestation in consensus.
//   FORGE : witness = a value the holder does NOT have (different from the
//           committed leaf), reusing the real path → REJECTED at circuit
//           execution by the binding assert, so no proof transcript can form.
//
// The binding asserts run in the impure JS circuit run (createUnprovenCallTx)
// before the predicate check, so a fabricated witness dies before proving.
// For nationality/residency the forged country is kept inside the verifier's
// allowed set, so the set-membership assert passes and ONLY the owl_root
// binding rejects it.
//
// A fresh per-run salt nonce makes every owl_root (and thus every attestation
// key + personhood nullifier) unique, so the sweep is re-runnable.
//
// Run: bun scripts/forge-test.ts  (sidecar on :3000, proof server on :6300)

import { createCallTxOptions, createUnprovenCallTx } from '@midnight-ntwrk/midnight-js-contracts'
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id'
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider'
import {
  buildOwlRootTree,
  findClaimPath,
  owlRootBytesLE,
  salt32For,
} from '../src/midnight/owl-root.js'
import { buildAllowedSetTree, treeRootBytesLE } from '../src/midnight/merkle.js'
import {
  createSnapshotPublicDataProvider,
  type PredicateSnapshot,
} from '../src/midnight/snapshot.js'
import { buildCompiledContract } from '../src/midnight/witnesses.js'
import type { PredicateKind } from '../src/midnight/kinds.js'
import { bytesToHex } from '../src/encoding.js'
import { createInProcessProofProvider } from '../../midnight-sidecar/src/inprocess-proof.js'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

setNetworkId('undeployed')

const here = dirname(fileURLToPath(import.meta.url))
const MANAGED = (kind: PredicateKind) =>
  resolve(here, `../../midnight-sidecar/managed/predicate_${kind}`)
const API = 'http://localhost:3000/api/predicates'
const AUTH = { Authorization: 'Bearer API_KEY_DEV' }

const offChainStubWallet = {
  getCoinPublicKey: () => '00'.repeat(32),
  getEncryptionPublicKey: () => '00'.repeat(32),
  balanceTx: () => {
    throw new Error('holder must not balance/submit')
  },
}
function inMemoryPSP(addr: string) {
  const store = new Map<string, unknown>()
  return {
    _contractAddress: addr,
    setContractAddress(_: string) {},
    async get(id: string) {
      return store.has(id) ? store.get(id) : {}
    },
    async set(id: string, ps: unknown) {
      store.set(id, ps)
    },
    async remove(id: string) {
      store.delete(id)
    },
    async clear() {
      store.clear()
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rand32 = () => crypto.getRandomValues(new Uint8Array(32))
const randHex = (n: number) => bytesToHex(crypto.getRandomValues(new Uint8Array(n)))

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', b))
}
/** SHA-256(client_id utf8) — same value the Compact `verifierIdHash()` witness returns. */
async function verifierIdHashOf(id: string): Promise<Uint8Array> {
  return sha256(new TextEncoder().encode(id))
}
/** setHash = SHA-256(verifierIdHash || merkleRootLE(allowed set)). */
async function setHashOf(vidHash: Uint8Array, canon: string[]): Promise<Uint8Array> {
  const { tree } = buildAllowedSetTree(canon)
  const root = treeRootBytesLE(tree)
  const outer = new Uint8Array(64)
  outer.set(vidHash, 0)
  outer.set(root, 32)
  return sha256(outer)
}
/** First day of the current UTC month, YYYYMM01 — the age freshness epoch. */
function currentAgeEpoch(): bigint {
  const now = new Date()
  return BigInt(now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + 1)
}
const dobYmd = (s: string): bigint => {
  const [y, m, d] = s.split('-').map(Number)
  return BigInt(y * 10000 + m * 100 + d)
}

// ---------------------------------------------------------------------------
// One synthetic credential committing every bound claim under one owl_root.
// ---------------------------------------------------------------------------
const nonce = randHex(8)
const personSecretHex = randHex(32)
const disclosures = [
  { name: 'verification_level', value: 'low', salt: `vl-${nonce}` },
  { name: 'email_verified', value: true, salt: `ev-${nonce}` },
  { name: 'nationality', value: 'DE', salt: `nat-${nonce}` },
  { name: 'residentCountry', value: 'DE', salt: `res-${nonce}` },
  { name: 'birthdate', value: '1990-01-01', salt: `bd-${nonce}` },
  { name: 'personhoodSecret', value: personSecretHex, salt: `ph-${nonce}` },
]
const saltByName = new Map(disclosures.map((d) => [d.name, d.salt]))
const tree = buildOwlRootTree(disclosures)
const owlRoot = owlRootBytesLE(tree)

const ALLOWED = ['DE', 'FR'] // forged country (FR) stays in-set so only the binding rejects
const VERIFIER_ID = 'https://verifier.example/forge-test'
const vidHash = await verifierIdHashOf(VERIFIER_ID)
const setHash = await setHashOf(vidHash, ALLOWED)
const asOf = currentAgeEpoch()
const epoch32 = rand32()
const appId32 = rand32()

/** claim-binding witness fields for the given bound claim. */
function binding(claimName: string) {
  const salt = saltByName.get(claimName)
  if (!salt) throw new Error(`no salt for ${claimName}`)
  return { claimSalt: salt32For(salt), claimPath: findClaimPath(tree, claimName) }
}

interface Spec {
  kind: PredicateKind
  circuitId: string
  claim: string
  bindingMsg: string
  legitWitness: Record<string, unknown>
  forgeWitness: Record<string, unknown>
  args: unknown[]
}

const SPECS: Spec[] = [
  {
    kind: 'kyc',
    circuitId: 'attestKycGte',
    claim: 'verification_level',
    bindingMsg: 'claim commitment != kycLevel witness',
    legitWitness: { kycLevel: 1n, ...binding('verification_level') },
    forgeWitness: { kycLevel: 9n, ...binding('verification_level') },
    args: [owlRoot, 1n],
  },
  {
    kind: 'email',
    circuitId: 'attestEmailVerified',
    claim: 'email_verified',
    bindingMsg: 'claim commitment != emailVerified witness',
    legitWitness: { emailVerifiedFlag: 1n, ...binding('email_verified') },
    forgeWitness: { emailVerifiedFlag: 0n, ...binding('email_verified') },
    args: [owlRoot],
  },
  {
    kind: 'age',
    circuitId: 'attestAgeGte',
    claim: 'birthdate',
    bindingMsg: 'claim commitment != birthdate witness',
    legitWitness: { dobValue: dobYmd('1990-01-01'), ...binding('birthdate') },
    forgeWitness: { dobValue: dobYmd('2010-01-01'), ...binding('birthdate') },
    args: [owlRoot, 18n, asOf],
  },
  {
    kind: 'age_range',
    circuitId: 'attestAgeRange',
    claim: 'birthdate',
    bindingMsg: 'claim commitment != birthdate witness',
    legitWitness: { dobValue: dobYmd('1990-01-01'), ...binding('birthdate') },
    forgeWitness: { dobValue: dobYmd('2010-01-01'), ...binding('birthdate') },
    args: [owlRoot, 18n, 99n, asOf],
  },
  {
    kind: 'nationality',
    circuitId: 'attestNationalityIn',
    claim: 'nationality',
    bindingMsg: 'claim commitment != nationality witness',
    legitWitness: {
      nationalityCode: 'DE',
      allowedCountrySet: ALLOWED,
      verifierIdHash: vidHash,
      ...binding('nationality'),
    },
    forgeWitness: {
      nationalityCode: 'FR',
      allowedCountrySet: ALLOWED,
      verifierIdHash: vidHash,
      ...binding('nationality'),
    },
    args: [owlRoot, setHash],
  },
  {
    kind: 'residency',
    circuitId: 'attestResidencyIn',
    claim: 'residentCountry',
    bindingMsg: 'claim commitment != residentCountry witness',
    legitWitness: {
      residentCountry: 'DE',
      allowedCountrySet: ALLOWED,
      verifierIdHash: vidHash,
      ...binding('residentCountry'),
    },
    forgeWitness: {
      residentCountry: 'FR',
      allowedCountrySet: ALLOWED,
      verifierIdHash: vidHash,
      ...binding('residentCountry'),
    },
    args: [owlRoot, setHash],
  },
  {
    kind: 'personhood',
    circuitId: 'attestUniquePersonhood',
    claim: 'personhoodSecret',
    bindingMsg: 'claim commitment != personhoodSecret witness',
    legitWitness: { personhoodSecret: hexToU8(personSecretHex), ...binding('personhoodSecret') },
    forgeWitness: { personhoodSecret: rand32(), ...binding('personhoodSecret') },
    args: [owlRoot, epoch32, appId32],
  },
]

function hexToU8(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

// ---------------------------------------------------------------------------
// per-kind providers (snapshot + zkConfig + in-process prover), cached
// ---------------------------------------------------------------------------
const snapshots = new Map<PredicateKind, PredicateSnapshot>()
async function snapshotFor(kind: PredicateKind): Promise<PredicateSnapshot> {
  const hit = snapshots.get(kind)
  if (hit) return hit
  const s = await fetch(`${API}/${kind}/snapshot`, { headers: AUTH }).then((r) => {
    if (!r.ok) throw new Error(`snapshot ${kind}: HTTP ${r.status}`)
    return r.json()
  })
  snapshots.set(kind, s)
  return s
}

type Stage = 'exec' | 'prove' | 'ok'
interface Outcome {
  stage: Stage
  message?: string
  provenHex?: string
}

async function attempt(spec: Spec, witness: Record<string, unknown>): Promise<Outcome> {
  const snapshot = await snapshotFor(spec.kind)
  const zk = new NodeZkConfigProvider(MANAGED(spec.kind))
  const proofProvider = createInProcessProofProvider(zk)
  const compiled = buildCompiledContract(spec.kind, witness as never)
  const opts = (createCallTxOptions as (...a: unknown[]) => unknown)(
    compiled,
    spec.circuitId,
    snapshot.address,
    `owlid-predicate-${spec.kind}`,
    undefined,
    spec.args,
  )
  let unsub: { private: { unprovenTx: unknown } }
  try {
    unsub = (await (createUnprovenCallTx as (...a: unknown[]) => Promise<unknown>)(
      {
        zkConfigProvider: zk,
        publicDataProvider: createSnapshotPublicDataProvider(snapshot),
        privateStateProvider: inMemoryPSP(snapshot.address),
        walletProvider: offChainStubWallet,
      },
      opts,
    )) as { private: { unprovenTx: unknown } }
  } catch (e) {
    return { stage: 'exec', message: e instanceof Error ? e.message : String(e) }
  }
  let proven: { serialize(): Uint8Array }
  try {
    proven = (await proofProvider.proveTx(unsub.private.unprovenTx as never)) as {
      serialize(): Uint8Array
    }
  } catch (e) {
    return { stage: 'prove', message: e instanceof Error ? e.message : String(e) }
  }
  return { stage: 'ok', provenHex: bytesToHex(proven.serialize()) }
}

async function countOf(kind: PredicateKind): Promise<number> {
  const r = await fetch(`${API}/${kind}/count`, { headers: AUTH }).then((x) => x.json())
  return Number(r.attestCount)
}
/** Relay the proven tx; poll the attestations Set size until it grows — i.e.
 *  the Midnight node verified the proof in consensus and recorded the key. */
async function submitAndConfirm(kind: PredicateKind, provenHex: string): Promise<string | null> {
  const before = await countOf(kind)
  const relay = await fetch(`${API}/${kind}/relay`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provenTx: provenHex }),
  }).then((r) => r.json())
  for (let i = 0; i < 60; i++) {
    await sleep(2000)
    if ((await countOf(kind)) > before) return relay.jobId
  }
  return null
}

// ---------------------------------------------------------------------------
console.log(`owl_root = ${bytesToHex(owlRoot)}  (run nonce ${nonce})`)
console.log('')

interface Row {
  kind: string
  legit: string
  forge: string
}
const rows: Row[] = []

for (const spec of SPECS) {
  let legit = ''
  let forge = ''

  const lo = await attempt(spec, spec.legitWitness)
  if (lo.stage === 'ok' && lo.provenHex) {
    const jobId = await submitAndConfirm(spec.kind, lo.provenHex)
    legit = jobId
      ? `proof+on-chain ✓ (job ${jobId.slice(0, 8)})`
      : 'proof ✓ but NOT confirmed on-chain ✗'
  } else {
    legit = `FAILED at ${lo.stage}: ${lo.message}`
  }

  const fo = await attempt(spec, spec.forgeWitness)
  if (fo.stage === 'exec' && (fo.message ?? '').includes(spec.bindingMsg)) {
    forge = 'rejected at exec (binding) ✓'
  } else if (fo.stage === 'ok') {
    forge = 'PROOF GENERATED ✗✗ BAD — forgery succeeded'
  } else {
    forge = `rejected at ${fo.stage}: ${(fo.message ?? '').slice(0, 80)}`
  }

  rows.push({ kind: spec.kind, legit, forge })
  console.log(`${spec.kind.padEnd(12)} LEGIT: ${legit}`)
  console.log(`${''.padEnd(12)} FORGE: ${forge}`)
}

console.log('\n================ SUMMARY ================')
let allGood = true
for (const r of rows) {
  const ok = r.legit.includes('on-chain ✓') && r.forge.includes('rejected at exec (binding) ✓')
  if (!ok) allGood = false
  console.log(`${ok ? '✓' : '✗'} ${r.kind}`)
}
console.log(allGood ? '\nALL 7 PREDICATES VERIFIED ✓' : '\nSOME PREDICATES FAILED ✗')
