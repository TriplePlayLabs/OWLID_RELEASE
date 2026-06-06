/**
 * OwlID Midnight Client (Node.js / Sidecar only)
 *
 * High-level API for the 3 OwlID contracts on Midnight.
 * Uses NodeZkConfigProvider with filesystem paths — no browser support needed.
 */

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts'
import { CompiledContract } from '@midnight-ntwrk/compact-js'
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider'
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider'
import { createInProcessProofProvider } from './inprocess-proof.js'
import { Transaction } from '@midnight-ntwrk/ledger-v8'
import type { StateValue, ContractState } from '@midnight-ntwrk/compact-runtime'
import { persistentHash, Bytes32Descriptor } from '@midnight-ntwrk/compact-runtime'
import { join } from 'path'

import {
  Contract as IssuerContract,
  ledger as issuerLedger,
} from '../managed/issuer_registry/contract/index.js'
import type { Ledger as IssuerLedger } from '../managed/issuer_registry/contract/index.js'

import {
  Contract as RevocationContract,
  ledger as revocationLedger,
} from '../managed/revocation_registry/contract/index.js'
import type { Ledger as RevocationLedger } from '../managed/revocation_registry/contract/index.js'

import {
  Contract as IdentityContract,
  ledger as identityLedger,
} from '../managed/identity_registry/contract/index.js'
import type { Ledger as IdentityLedger } from '../managed/identity_registry/contract/index.js'

// Per-predicate contracts — one Compact contract address per predicate
// to stay under Midnight's per-extrinsic deploy-weight cap. All seven
// expose the same shape (`attestations: Set<Bytes<32>>`, `attestTree`,
// `attestCount`, `isAttested(key)`) plus their kind-specific `attest*`
// circuit, so the rest of the sidecar treats them uniformly via the
// `PREDICATE_DESCRIPTORS` table below.
import {
  Contract as PredicateAgeContract,
  ledger as predicateAgeLedger,
} from '../managed/predicate_age/contract/index.js'
import {
  Contract as PredicateKycContract,
  ledger as predicateKycLedger,
} from '../managed/predicate_kyc/contract/index.js'
import {
  Contract as PredicateResidencyContract,
  ledger as predicateResidencyLedger,
} from '../managed/predicate_residency/contract/index.js'
import {
  Contract as PredicateEmailContract,
  ledger as predicateEmailLedger,
} from '../managed/predicate_email/contract/index.js'
import {
  Contract as PredicateNationalityContract,
  ledger as predicateNationalityLedger,
} from '../managed/predicate_nationality/contract/index.js'
import {
  Contract as PredicateAgeRangeContract,
  ledger as predicateAgeRangeLedger,
} from '../managed/predicate_age_range/contract/index.js'
import {
  Contract as PredicatePersonhoodContract,
  ledger as predicatePersonhoodLedger,
} from '../managed/predicate_personhood/contract/index.js'
import type { PredicateKind, PredicateAddresses } from './config.js'
import { PREDICATE_KINDS } from './config.js'

import {
  createIdentityRegistryWitnesses,
  createRevocationRegistryWitnesses,
  createPredicateRegistryWitnesses,
  type PredicatePending,
} from './witnesses.js'
import type { MerkleTreePath } from '@owlid/sdk/midnight'
import {
  eventBus,
  type IdentityEvent,
  type IssuerEvent,
  type RelayJobEvent,
  type RevocationEvent,
  type SidecarEvent,
} from './events.js'
import { log } from './log.js'
import { isDustShortfallError } from './dust-errors.js'
import { RelayBatcher } from './relay-batcher.js'

// =============================================================================
// Relay job bookkeeping
// =============================================================================

/** Lifecycle of a fire-and-forget /predicates/{kind}/relay request.
 *  See `MidnightClient.relayProvenTx` for the contract.
 *
 *  Naming: `jobId` is the local handle the relay endpoint returns
 *  immediately; `chainTxId` is the on-chain identifier the SDK gives
 *  us after `submitTx` returns. The two USED to be conflated under
 *  the field name `txId` — they're now explicit so the SSE route
 *  doesn't have to probe-then-decide what kind of id it has. */
interface RelayJob {
  jobId: string
  phase: 'queued' | 'balancing' | 'submitting' | 'submitted' | 'balance-failed' | 'submit-failed'
  /** Chain transaction id once `submitTx` has returned. Unset while the
   *  job is still queued/balancing/submitting. */
  chainTxId?: string
  /** Error message captured if the background driver failed. */
  error?: string
  startedAt: number
}

/** 32-byte hex string. */
function randomJobId(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// =============================================================================
// Types
// =============================================================================

export interface ContractAddresses {
  issuerRegistry?: string
  revocationRegistry?: string
  identityRegistry?: string
  /** Per-predicate registry addresses. Missing addresses for a kind
   *  are silently skipped at connect time — that predicate is then
   *  unavailable but doesn't block the rest. */
  predicates?: Partial<PredicateAddresses>
}

/**
 * Per-predicate Compact contract descriptor. Names + ledger functions
 * are the only differences between contracts — every other field on
 * the API is shared, so the rest of the file works through this
 * table instead of per-kind branches.
 */
interface PredicateDescriptor {
  kind: PredicateKind
  managedDir: string
  privateStateId: string
  contractClass: unknown
  ledgerFn: (state: StateValue) => unknown
}

const PREDICATE_DESCRIPTORS: readonly PredicateDescriptor[] = [
  {
    kind: 'age',
    managedDir: 'predicate_age',
    privateStateId: 'owlid-predicate-age',
    contractClass: PredicateAgeContract,
    ledgerFn: predicateAgeLedger as unknown as (s: StateValue) => unknown,
  },
  {
    kind: 'kyc',
    managedDir: 'predicate_kyc',
    privateStateId: 'owlid-predicate-kyc',
    contractClass: PredicateKycContract,
    ledgerFn: predicateKycLedger as unknown as (s: StateValue) => unknown,
  },
  {
    kind: 'residency',
    managedDir: 'predicate_residency',
    privateStateId: 'owlid-predicate-residency',
    contractClass: PredicateResidencyContract,
    ledgerFn: predicateResidencyLedger as unknown as (s: StateValue) => unknown,
  },
  {
    kind: 'email',
    managedDir: 'predicate_email',
    privateStateId: 'owlid-predicate-email',
    contractClass: PredicateEmailContract,
    ledgerFn: predicateEmailLedger as unknown as (s: StateValue) => unknown,
  },
  {
    kind: 'nationality',
    managedDir: 'predicate_nationality',
    privateStateId: 'owlid-predicate-nationality',
    contractClass: PredicateNationalityContract,
    ledgerFn: predicateNationalityLedger as unknown as (s: StateValue) => unknown,
  },
  {
    kind: 'age_range',
    managedDir: 'predicate_age_range',
    privateStateId: 'owlid-predicate-age-range',
    contractClass: PredicateAgeRangeContract,
    ledgerFn: predicateAgeRangeLedger as unknown as (s: StateValue) => unknown,
  },
  {
    kind: 'personhood',
    managedDir: 'predicate_personhood',
    privateStateId: 'owlid-predicate-personhood',
    contractClass: PredicatePersonhoodContract,
    ledgerFn: predicatePersonhoodLedger as unknown as (s: StateValue) => unknown,
  },
]

/** Common ledger shape every per-predicate contract exposes. */
interface PredicateLedgerShape {
  attestations: { member(key: Uint8Array): boolean }
  attestCount: bigint
}

export interface MidnightNodeConfig {
  indexerUri: string
  indexerWsUri: string
  /** Path to compiled contract managed/ directory (contains keys/, zkir/) */
  managedDir: string
  /** Private state store name */
  privateStateStoreName?: string
  accountId?: string
  privateStoragePasswordProvider?: () => string | Promise<string>
  /** Wallet provider */
  walletProvider: {
    getCoinPublicKey(): string
    getEncryptionPublicKey(): string
    balanceTx(tx: unknown, ttl?: Date): Promise<unknown>
  }
  /** Midnight provider */
  midnightProvider: {
    submitTx(tx: unknown): Promise<unknown>
  }
}

export enum IssuerStatus {
  INACTIVE = 0,
  ACTIVE = 1,
  DEACTIVATED = 2,
}

export enum CredentialStatus {
  ACTIVE = 0,
  REVOKED = 1,
  SUSPENDED = 2,
}

export enum CommitmentStatus {
  INACTIVE = 0,
  ACTIVE = 1,
  EXPIRED = 2,
}

interface ContractAPI<L> {
  callTx: Record<string, (...args: unknown[]) => Promise<unknown>>
  get ledgerState(): L
  subscription: { unsubscribe(): void }
}

// =============================================================================
// Midnight Client
// =============================================================================

export class MidnightClient {
  private addresses: ContractAddresses
  private connected = false
  private ownerSecretKey: Uint8Array | null = null

  private issuerApi: ContractAPI<IssuerLedger> | null = null
  private revocationApi: ContractAPI<RevocationLedger> | null = null
  private identityApi: ContractAPI<IdentityLedger> | null = null
  /** Per-predicate ContractAPI map. Keys are PredicateKind. Absent
   *  entries = predicate not configured (no address in env). */
  private predicateApis: Map<PredicateKind, ContractAPI<PredicateLedgerShape>> = new Map()

  // Retained for the holder-device prove-without-submit split:
  // snapshotPredicate() reads chain state for the holder; relayProvenTx()
  // balances+submits a holder-proven tx. Holder itself stays off-chain.
  private publicDataProvider: ReturnType<typeof indexerPublicDataProvider> | null = null
  private nodeConfig: MidnightNodeConfig | null = null

  // Request-scoped private witness for the next predicate attest.
  // All contract callTx writes are serialized via `callTxChain`: they share
  // ONE `levelPrivateStateProvider` (LevelDB, single-handle), so two
  // concurrent scoped private-state transactions race the DB lock and one
  // fails "Database failed to open". Serializing makes concurrent writes
  // queue instead of crash. (The relay/presentation hot path does NOT touch
  // private state — it only balances+submits a holder-proven tx — so it is
  // unaffected and stays concurrent via the wallet supervisor's pipeline.)
  private pendingPredicate: PredicatePending = {}
  private callTxChain: Promise<unknown> = Promise.resolve()

  // Fire-and-forget relay jobs: jobId -> phase + (eventually) chain
  // txId. `relayProvenTx` returns a jobId immediately and runs
  // `balanceTx` + `submitTx` in the background, so the holder's HTTP
  // request never blocks on wallet recovery or chain submission.
  // `pollTxStatus` accepts both jobIds + raw txIds: jobIds resolve via
  // this map, txIds fall straight through to `watchForTxData`.
  private relayJobs: Map<string, RelayJob> = new Map()
  /** Keep job records around long enough for the orchestrator's 5-min
   *  polling cap, then discard so the map doesn't grow without bound. */
  private static readonly RELAY_JOB_TTL_MS = 30 * 60 * 1000

  // Coalesces concurrent relays into one merged chain tx so a single balance
  // amortizes across K attestations. Created in `connect()` once the
  // wallet/submit provider is wired.
  private relayBatcher: RelayBatcher<unknown> | null = null

  constructor(addresses: ContractAddresses = {}) {
    this.addresses = addresses
  }

  setOwnerSecretKey(secretKey: Uint8Array): void {
    this.ownerSecretKey = secretKey
  }

  /**
   * Connect to Midnight and join all configured contracts.
   * Builds providers directly from config — no abstraction layers.
   */
  async connect(config: MidnightNodeConfig): Promise<void> {
    const privateStateProvider = levelPrivateStateProvider({
      privateStateStoreName: config.privateStateStoreName ?? 'owlid-sidecar-state',
      privateStoragePasswordProvider:
        config.privateStoragePasswordProvider ?? (() => 'owlid-sidecar-secret-2026'),
      accountId: config.accountId ?? 'sidecar',
    })

    const publicDataProvider = indexerPublicDataProvider(config.indexerUri, config.indexerWsUri)
    this.publicDataProvider = publicDataProvider
    this.nodeConfig = config

    // Batch concurrent relays: buffer for a short window, merge into one tx,
    // submit once. `flush` returns the shared chain tx id for every job in the
    // batch. A failed merge/submit rejects the whole batch (holders retry).
    this.relayBatcher = new RelayBatcher<unknown>({
      windowMs: Number(process.env.RELAY_BATCH_WINDOW_MS ?? 250),
      maxBatch: Number(process.env.RELAY_BATCH_MAX ?? 32),
      flush: async (txs) => {
        const merged = txs.reduce((a, b) => (a as { merge: (o: unknown) => unknown }).merge(b))
        return (await this.nodeConfig!.midnightProvider.submitTx(merged)) as string
      },
      onEvent: (event, fields) =>
        event.endsWith('.error') ? log.warn(event, fields) : log.info(event, fields),
    })

    const sharedProviders = {
      privateStateProvider,
      publicDataProvider,
      walletProvider: config.walletProvider,
      midnightProvider: config.midnightProvider,
    }

    if (this.addresses.issuerRegistry) {
      this.issuerApi = await this.joinContract(
        sharedProviders,
        publicDataProvider,
        config,
        this.addresses.issuerRegistry,
        'issuer-registry',
        'issuer_registry',
        IssuerContract,
        issuerLedger,
        'owlid-issuer-registry',
        {},
        undefined,
        diffIssuer,
      )
    }

    if (this.addresses.revocationRegistry) {
      this.revocationApi = await this.joinContract(
        sharedProviders,
        publicDataProvider,
        config,
        this.addresses.revocationRegistry,
        'revocation-registry',
        'revocation_registry',
        RevocationContract,
        revocationLedger,
        'owlid-revocation-registry',
        {},
        createRevocationRegistryWitnesses(),
        diffRevocation,
      )
    }

    if (this.addresses.identityRegistry) {
      this.identityApi = await this.joinContract(
        sharedProviders,
        publicDataProvider,
        config,
        this.addresses.identityRegistry,
        'identity-registry',
        'identity_registry',
        IdentityContract,
        identityLedger,
        'owlid-identity-registry',
        this.ownerSecretKey ? { secretKey: this.ownerSecretKey } : {},
        this.ownerSecretKey ? createIdentityRegistryWitnesses(this.ownerSecretKey) : undefined,
        diffIdentity,
      )
    }

    // Join every configured per-predicate contract. Each has the same
    // witnesses (the createPredicateRegistryWitnesses factory reads
    // `pendingPredicate` for whichever attest is in flight) but a
    // distinct address + private-state id + ledger function.
    for (const desc of PREDICATE_DESCRIPTORS) {
      const addr = this.addresses.predicates?.[desc.kind]
      if (!addr) continue
      try {
        const api = await this.joinContract(
          sharedProviders,
          publicDataProvider,
          config,
          addr,
          desc.kind.replace(/_/g, '-'),
          desc.managedDir,
          desc.contractClass as never,
          desc.ledgerFn as never,
          desc.privateStateId,
          {},
          createPredicateRegistryWitnesses(() => this.pendingPredicate),
          // diffPredicate emits attestation deltas to the SSE stream.
          // Each contract gets the same emitter — its address is
          // already part of the `attest_key` so consumers can tell
          // them apart at the verifier-side cache. Per-predicate
          // event types can be added later if needed.
          diffPredicate,
        )
        this.predicateApis.set(desc.kind, api as ContractAPI<PredicateLedgerShape>)
      } catch (e) {
        // Don't kill the whole sidecar over one bad predicate contract.
        // Log + continue; that kind just stays unavailable.
        // eslint-disable-next-line no-console
        console.error(`[midnight] Failed to join ${desc.kind} predicate contract:`, e)
      }
    }

    this.connected = true
  }

  disconnect(): void {
    this.issuerApi?.subscription.unsubscribe()
    this.revocationApi?.subscription.unsubscribe()
    this.identityApi?.subscription.unsubscribe()
    for (const api of this.predicateApis.values()) {
      api.subscription.unsubscribe()
    }
    this.issuerApi = null
    this.revocationApi = null
    this.identityApi = null
    this.predicateApis.clear()
    this.connected = false
  }

  /** Look up a predicate's joined ContractAPI; throws if not joined. */
  private getPredicateApi(kind: PredicateKind): ContractAPI<PredicateLedgerShape> {
    const api = this.predicateApis.get(kind)
    if (!api) {
      throw new Error(
        `Predicate '${kind}' contract not joined — set MIDNIGHT_PREDICATE_${kind.toUpperCase()}_ADDRESS`,
      )
    }
    return api
  }

  // =========================================================================
  // Predicate Registry (Midnight-native ZK attestations)
  // =========================================================================

  // Serialize a contract callTx write against the shared private-state DB.
  // `pending` carries the request-scoped witness for attests (empty for
  // non-attest writes like registerIdentity / revoke). One in-flight write
  // at a time → no LevelDB "Database failed to open" race, and the attest
  // witness is unambiguous for the single in-flight circuit call.
  private async runCallTx<T>(fn: () => Promise<T>, pending: PredicatePending = {}): Promise<T> {
    const run = this.callTxChain.then(async () => {
      this.pendingPredicate = pending
      try {
        return await fn()
      } finally {
        this.pendingPredicate = {}
      }
    })
    this.callTxChain = run.catch(() => undefined)
    return run
  }

  private runAttest<T>(pending: PredicatePending, fn: () => Promise<T>): Promise<T> {
    return this.runCallTx(fn, pending)
  }

  async attestAge(rootHash: Uint8Array, threshold: number, age: number): Promise<void> {
    const api = this.getPredicateApi('age')
    await this.runAttest({ age: BigInt(age) }, async () => {
      await api.callTx.attestAgeGte(rootHash, BigInt(threshold))
    })
  }

  async attestKyc(rootHash: Uint8Array, threshold: number, kycLevel: number): Promise<void> {
    const api = this.getPredicateApi('kyc')
    await this.runAttest({ kycLevel: BigInt(kycLevel) }, async () => {
      await api.callTx.attestKycGte(rootHash, BigInt(threshold))
    })
  }

  /** Prove the holder's nationality is in the verifier-supplied allowed
   *  set. All policy data is private:
   *    - `nationalityCode` = holder's alpha-2 code right-padded to 32B
   *    - `allowedCountryPath` = Merkle inclusion proof (depth 8) for
   *      the holder's country in the verifier's canonical allowed-set
   *      tree (sorted+deduped+uppercased+zero-padded leaves)
   *    - `verifierIdHash` = SHA-256(client_id) — per-verifier salt
   *  Only `setHash` (= SHA-256(verifierIdHash || rootLE)) is public. */
  async attestNationality(
    rootHash: Uint8Array,
    nationalityCode: Uint8Array,
    allowedCountryPath: MerkleTreePath<Uint8Array>,
    verifierIdHash: Uint8Array,
    setHash: Uint8Array,
  ): Promise<void> {
    const api = this.getPredicateApi('nationality')
    await this.runAttest({ nationalityCode, allowedCountryPath, verifierIdHash }, async () => {
      await api.callTx.attestNationalityIn(rootHash, setHash)
    })
  }

  /** Prove the holder's residence country is in the verifier-supplied
   *  allowed set. Same shape as `attestNationality`. */
  async attestResidency(
    rootHash: Uint8Array,
    residentCountry: Uint8Array,
    allowedCountryPath: MerkleTreePath<Uint8Array>,
    verifierIdHash: Uint8Array,
    setHash: Uint8Array,
  ): Promise<void> {
    const api = this.getPredicateApi('residency')
    await this.runAttest({ residentCountry, allowedCountryPath, verifierIdHash }, async () => {
      await api.callTx.attestResidencyIn(rootHash, setHash)
    })
  }

  /** Email-verified flag (provider-attested). */
  async attestEmailVerified(rootHash: Uint8Array, flag: number): Promise<void> {
    const api = this.getPredicateApi('email')
    await this.runAttest({ emailVerified: BigInt(flag) }, async () => {
      await api.callTx.attestEmailVerified(rootHash)
    })
  }

  /** Age range `[minAge, maxAge]`. */
  async attestAgeRange(
    rootHash: Uint8Array,
    minAge: number,
    maxAge: number,
    age: number,
  ): Promise<void> {
    const api = this.getPredicateApi('age_range')
    await this.runAttest({ age: BigInt(age) }, async () => {
      await api.callTx.attestAgeRange(rootHash, BigInt(minAge), BigInt(maxAge))
    })
  }

  /** Unique-personhood per (epoch, app_id). */
  async attestUniquePersonhood(
    rootHash: Uint8Array,
    epoch: Uint8Array,
    appId: Uint8Array,
    personhoodSecret: Uint8Array,
  ): Promise<void> {
    const api = this.getPredicateApi('personhood')
    await this.runAttest({ personhoodSecret }, async () => {
      await api.callTx.attestUniquePersonhood(rootHash, epoch, appId)
    })
  }

  /** Per-predicate attestation Set size. */
  predicateAttestCount(kind: PredicateKind): bigint {
    return this.getPredicateApi(kind).ledgerState.attestCount
  }

  /** Membership of a precomputed attestation key in the kind's Set. */
  isAttestedFromLedger(kind: PredicateKind, key: Uint8Array): boolean {
    return this.getPredicateApi(kind).ledgerState.attestations.member(key)
  }

  /** Iterate every joined predicate kind (useful for SSE replay etc.). */
  joinedPredicateKinds(): PredicateKind[] {
    return Array.from(this.predicateApis.keys())
  }

  // =========================================================================
  // Holder-device prove-without-submit split
  //
  // The holder app proves predicate circuits locally (witness on
  // device) against a backend-supplied state snapshot, then ships a
  // proven, unsubmitted tx here. The holder never touches the chain;
  // these two methods are the only backend seam.
  // =========================================================================

  /**
   * State snapshot the holder feeds to a snapshot-backed
   * PublicDataProvider for offline `createUnprovenCallTx` (carries the
   * `approvedNationality` HistoricMerkleTree for nationality). Wire
   * shape == `@owlid/sdk` `PredicateSnapshot`.
   */
  async snapshotPredicate(kind: PredicateKind): Promise<{
    address: string
    zswapChainState: string
    contractState: string
    ledgerParameters: string
  }> {
    this.getPredicateApi(kind) // assert joined
    const address = this.addresses.predicates?.[kind]
    if (!address) {
      log.error('predicate.snapshot.no-address', { kind })
      throw new Error(`Predicate '${kind}' has no configured address`)
    }
    let states
    try {
      states = await this.publicDataProvider!.queryZSwapAndContractState(address)
    } catch (e) {
      // Indexer read failed (timeout / transient degradation). Distinct from a
      // clean null so a recurring snapshot 400 can be traced to the indexer.
      log.error('predicate.snapshot.indexer-error', {
        kind,
        address,
        err: e instanceof Error ? e.message : String(e),
      })
      throw e
    }
    if (!states) {
      log.error('predicate.snapshot.no-state', { kind, address })
      throw new Error(`no public state at ${address}`)
    }
    const [zswap, contract, params] = states
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
    return {
      address,
      zswapChainState: hex(zswap.serialize()),
      contractState: hex(contract.serialize()),
      ledgerParameters: hex(params.serialize()),
    }
  }

  /**
   * Accept a holder-proven `UnboundTransaction` and return a job-id
   * immediately. The witness is already gone (preimage → ZK proof);
   * this never sees it.
   *
   * True fire-and-forget: the HTTP request must NOT block on
   * `balanceTx` (which awaits wallet readiness) or `submitTx` (which
   * awaits the Polkadot node). Both run in the background; the holder
   * polls {@link pollTxStatus} with the returned job-id to learn the
   * current phase (`balancing` | `submitting` | `submitted` | terminal
   * chain status). Once the chain returns the real transaction id,
   * the job entry is updated with `txId` and subsequent status polls
   * race `watchForTxData` against a short timer — exactly the same
   * contract the SDK orchestrator already implements.
   *
   * Returning a job-id (rather than waiting for `submitTx` to produce
   * the real txId) is what makes this safe under Cloud Run's request
   * cap and under a wallet recovering from a transient WebSocket
   * disconnect: the holder's request closes in ≤10 ms regardless of
   * downstream state.
   */
  relayProvenTx(kind: PredicateKind, provenHex: string): { jobId: string; status: 'queued' } {
    this.getPredicateApi(kind) // assert joined
    const jobId = randomJobId()
    const job: RelayJob = { jobId, phase: 'queued', startedAt: Date.now() }
    this.relayJobs.set(jobId, job)
    log.info('relay.queued', { jobId, kind, provenSizeHex: provenHex.length })
    // Background submit. Never await — the caller's HTTP request
    // returns the next line below.
    void this.runRelayJob(job, kind, provenHex)
    return { jobId, status: 'queued' }
  }

  /**
   * Background driver for a single relay job. Updates the job phase as
   * `balanceTx` and `submitTx` complete, captures errors so the status
   * endpoint can surface them, and emits structured logs at every
   * transition so Cloud Logging shows the full lifecycle.
   */
  private async runRelayJob(job: RelayJob, kind: PredicateKind, provenHex: string): Promise<void> {
    const publishPhase = (): void => {
      eventBus.emit({
        type: 'relay',
        jobId: job.jobId,
        phase: job.phase,
        txId: job.chainTxId,
        error: job.error,
        ts: Date.now(),
      })
    }
    try {
      const bytes = new Uint8Array(Buffer.from(provenHex, 'hex'))
      // Deserialize per-job (bad hex fails only this job, not its batch).
      const proven = (
        Transaction as unknown as {
          deserialize: (s: string, p: string, b: string, raw: Uint8Array) => unknown
        }
      ).deserialize('signature', 'proof', 'pre-binding', bytes)
      // Hand to the batcher: it merges concurrent relays into one tx so a
      // single balance+submit covers the whole batch. The balance is fused
      // into the supervised submit, so there is no separate balance phase.
      job.phase = 'submitting'
      publishPhase()
      const t1 = Date.now()
      log.info('relay.submit.start', { jobId: job.jobId, kind })
      const chainTxId = await this.relayBatcher!.submit(proven)
      job.chainTxId = chainTxId
      job.phase = 'submitted'
      log.info('relay.submit.done', {
        jobId: job.jobId,
        kind,
        chainTxId,
        elapsedMs: Date.now() - t1,
      })
      publishPhase()
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      job.error = err
      // The real balance is fused into the supervised `submitTx`, so a dust
      // shortfall surfaces during the `submitting` phase even though it is a
      // balancing failure. Classify by the error so the phase is honest.
      const failedPhase =
        isDustShortfallError(e) || job.phase === 'balancing' ? 'balance-failed' : 'submit-failed'
      job.phase = failedPhase
      log.error('relay.background.error', {
        jobId: job.jobId,
        kind,
        phase: failedPhase,
        err,
      })
      publishPhase()
    } finally {
      // Schedule deferred cleanup so the status endpoint can still
      // observe the terminal phase, then drop the record to bound
      // memory growth.
      setTimeout(() => this.relayJobs.delete(job.jobId), MidnightClient.RELAY_JOB_TTL_MS).unref?.()
    }
  }

  /** Snapshot lookup for an in-flight or recently-completed relay
   *  job. Used by the SSE route to emit the current phase to a
   *  subscriber before waiting for the next eventBus push. */
  getRelayJob(jobId: string): {
    jobId: string
    phase: RelayJob['phase']
    chainTxId?: string
    error?: string
  } | null {
    const j = this.relayJobs.get(jobId)
    if (!j) return null
    return { jobId: j.jobId, phase: j.phase, chainTxId: j.chainTxId, error: j.error }
  }

  /** Single-event wait for `watchForTxData` to observe finalization
   *  for an on-chain tx-id. Driven by the indexer's apollo watchQuery
   *  (`pollInterval: 1000ms`); resolves on the first emission with a
   *  populated `transactionResult.status`. Time-to-resolution is the
   *  sum of: block inclusion (≤ block time), GRANDPA finalization
   *  (1-2 blocks), indexer ingest, and the 1 s poll cadence. Logged
   *  so an operator can attribute slow `/events` waits to chain or
   *  indexer lag rather than our code. */
  async awaitChainStatus(txId: string): Promise<string> {
    this.assertConnected()
    const t0 = Date.now()
    log.info('chain.await.start', { txId })
    const t = (await this.publicDataProvider!.watchForTxData(txId as never)) as {
      status?: string
    }
    log.info('chain.await.done', {
      txId,
      status: t.status ?? 'unknown',
      elapsedMs: Date.now() - t0,
    })
    return t.status ?? 'unknown'
  }

  isConnected(): boolean {
    return this.connected
  }

  // =========================================================================
  // Issuer Registry
  // =========================================================================

  /** Hash a public key the same way the contract does: persistentHash<Bytes<32>>(publicKey) */
  private issuerKeyHash(publicKey: Uint8Array): Uint8Array {
    return persistentHash(Bytes32Descriptor, publicKey)
  }

  isIssuerTrustedFromLedger(publicKey: Uint8Array): boolean {
    this.assertContract(this.issuerApi, 'Issuer')
    const keyHash = this.issuerKeyHash(publicKey)
    const ledger = this.issuerApi!.ledgerState
    return (
      ledger.issuerStatuses.member(keyHash) &&
      ledger.issuerStatuses.lookup(keyHash) === IssuerStatus.ACTIVE
    )
  }

  getIssuerStatusFromLedger(publicKey: Uint8Array): IssuerStatus {
    this.assertContract(this.issuerApi, 'Issuer')
    const keyHash = this.issuerKeyHash(publicKey)
    const ledger = this.issuerApi!.ledgerState
    if (!ledger.issuerStatuses.member(keyHash)) return IssuerStatus.INACTIVE
    return ledger.issuerStatuses.lookup(keyHash) as unknown as IssuerStatus
  }

  getIssuerCount(): bigint {
    this.assertContract(this.issuerApi, 'Issuer')
    return this.issuerApi!.ledgerState.issuerCount
  }

  async isIssuerTrusted(publicKey: Uint8Array): Promise<boolean> {
    this.assertContract(this.issuerApi, 'Issuer')
    return (await this.issuerApi!.callTx.isTrusted(publicKey)) as boolean
  }

  async registerIssuer(publicKey: Uint8Array, name: string): Promise<void> {
    this.assertContract(this.issuerApi, 'Issuer')
    await this.runCallTx(() => this.issuerApi!.callTx.registerIssuer(publicKey, name))
  }

  async deactivateIssuer(publicKey: Uint8Array): Promise<void> {
    this.assertContract(this.issuerApi, 'Issuer')
    const keyHash = this.issuerKeyHash(publicKey)
    await this.runCallTx(() => this.issuerApi!.callTx.deactivateIssuer(keyHash))
  }

  // =========================================================================
  // Revocation Registry
  // =========================================================================

  isCredentialRevokedFromLedger(rootHash: Uint8Array): boolean {
    this.assertContract(this.revocationApi, 'Revocation')
    const ledger = this.revocationApi!.ledgerState
    if (!ledger.credentialStatuses.member(rootHash)) return false
    const status = ledger.credentialStatuses.lookup(rootHash) as unknown as CredentialStatus
    return status === CredentialStatus.REVOKED || status === CredentialStatus.SUSPENDED
  }

  getCredentialStatusFromLedger(rootHash: Uint8Array): CredentialStatus {
    this.assertContract(this.revocationApi, 'Revocation')
    const ledger = this.revocationApi!.ledgerState
    if (!ledger.credentialStatuses.member(rootHash)) return CredentialStatus.ACTIVE
    return ledger.credentialStatuses.lookup(rootHash) as unknown as CredentialStatus
  }

  async isCredentialRevoked(rootHash: Uint8Array): Promise<boolean> {
    this.assertContract(this.revocationApi, 'Revocation')
    return (await this.revocationApi!.callTx.isRevoked(rootHash)) as boolean
  }

  async revokeCredential(
    rootHash: Uint8Array,
    issuerPublicKey: Uint8Array,
    reason: string,
  ): Promise<void> {
    this.assertContract(this.revocationApi, 'Revocation')
    const issuerKeyHash = this.issuerKeyHash(issuerPublicKey)
    await this.runCallTx(() => this.revocationApi!.callTx.revoke(rootHash, issuerKeyHash, reason))
  }

  async suspendCredential(
    rootHash: Uint8Array,
    issuerPublicKey: Uint8Array,
    reason: string,
  ): Promise<void> {
    this.assertContract(this.revocationApi, 'Revocation')
    const issuerKeyHash = this.issuerKeyHash(issuerPublicKey)
    await this.runCallTx(() => this.revocationApi!.callTx.suspend(rootHash, issuerKeyHash, reason))
  }

  async reactivateCredential(rootHash: Uint8Array, issuerPublicKey: Uint8Array): Promise<void> {
    this.assertContract(this.revocationApi, 'Revocation')
    const issuerKeyHash = this.issuerKeyHash(issuerPublicKey)
    await this.runCallTx(() => this.revocationApi!.callTx.reactivate(rootHash, issuerKeyHash))
  }

  // Submits a `proveRevocationInclusion` tx; succeeds iff `rootHash`
  // is present in the contract's `revokedTree` (current or historic).
  // The witness derives the Merkle path from live ledger state.
  async proveRevocationInclusion(rootHash: Uint8Array): Promise<void> {
    this.assertContract(this.revocationApi, 'Revocation')
    await this.runCallTx(() => this.revocationApi!.callTx.proveRevocationInclusion(rootHash))
  }

  // =========================================================================
  // Identity Registry
  // =========================================================================

  getCommitmentFromLedger(didHash: Uint8Array): Uint8Array | null {
    this.assertContract(this.identityApi, 'Identity')
    const ledger = this.identityApi!.ledgerState
    if (!ledger.commitments.member(didHash)) return null
    return ledger.commitments.lookup(didHash)
  }

  getCommitmentStatusFromLedger(didHash: Uint8Array): CommitmentStatus {
    this.assertContract(this.identityApi, 'Identity')
    const ledger = this.identityApi!.ledgerState
    if (!ledger.commitmentStatuses.member(didHash)) return CommitmentStatus.INACTIVE
    return ledger.commitmentStatuses.lookup(didHash) as unknown as CommitmentStatus
  }

  isCommitmentRegistered(commitment: Uint8Array): boolean {
    this.assertContract(this.identityApi, 'Identity')
    return this.identityApi!.ledgerState.registeredCommitments.member(commitment)
  }

  async registerIdentity(
    didHash: Uint8Array,
    commitment: Uint8Array,
    issuerKeyHash: Uint8Array,
  ): Promise<void> {
    this.assertContract(this.identityApi, 'Identity')
    if (!this.ownerSecretKey)
      throw new Error('Owner secret key not set. Call setOwnerSecretKey() first.')
    // `callTx.*` blocks on midnight-js's internal `watchForTxData`
    // (1 s poll until indexer reports tx in a finalized block). The
    // elapsed log here is the single biggest signal for "/issue is
    // slow" investigations — split it into prove+balance+submit+wait
    // breakdown if you need finer attribution.
    const t0 = Date.now()
    log.info('chain.callTx.start', { call: 'registerIdentity' })
    try {
      // Serialized: shares the LevelDB private-state store with every other
      // write, so concurrent calls would race the DB lock without this.
      await this.runCallTx(() =>
        this.identityApi!.callTx.registerIdentity(didHash, commitment, issuerKeyHash),
      )
      log.info('chain.callTx.done', {
        call: 'registerIdentity',
        elapsedMs: Date.now() - t0,
      })
    } catch (e) {
      log.error('chain.callTx.error', {
        call: 'registerIdentity',
        elapsedMs: Date.now() - t0,
        err: e instanceof Error ? e.message : String(e),
      })
      throw e
    }
  }

  async updateCommitment(
    didHash: Uint8Array,
    newCommitment: Uint8Array,
    issuerKeyHash: Uint8Array,
  ): Promise<void> {
    this.assertContract(this.identityApi, 'Identity')
    if (!this.ownerSecretKey)
      throw new Error('Owner secret key not set. Call setOwnerSecretKey() first.')
    await this.runCallTx(() =>
      this.identityApi!.callTx.updateCommitment(didHash, newCommitment, issuerKeyHash),
    )
  }

  async getCommitment(didHash: Uint8Array): Promise<Uint8Array> {
    this.assertContract(this.identityApi, 'Identity')
    return (await this.identityApi!.callTx.getCommitment(didHash)) as Uint8Array
  }

  // =========================================================================
  // Admin
  // =========================================================================

  async pauseContract(contract: 'issuer' | 'revocation' | 'identity'): Promise<void> {
    await this.runCallTx(() => this.getContractApi(contract).callTx.pause())
  }

  async unpauseContract(contract: 'issuer' | 'revocation' | 'identity'): Promise<void> {
    await this.runCallTx(() => this.getContractApi(contract).callTx.unpause())
  }

  async adminUpdateCommitment(
    didHash: Uint8Array,
    newCommitment: Uint8Array,
    issuerKeyHash: Uint8Array,
  ): Promise<void> {
    this.assertContract(this.identityApi, 'Identity')
    await this.runCallTx(() =>
      this.identityApi!.callTx.adminUpdateCommitment(didHash, newCommitment, issuerKeyHash),
    )
  }

  // =========================================================================
  // Snapshot for new SSE clients
  // =========================================================================

  /**
   * Yield one event per entry currently visible in ledger state.
   * Used by /events SSE on connect so a fresh consumer can rebuild
   * its cache without waiting for the next on-chain change.
   */
  *snapshotEvents(
    topics: ReadonlyArray<SidecarEvent['type']> = ['revocation', 'issuer', 'identity'],
  ): Generator<SidecarEvent> {
    const ts = Date.now()
    if (topics.includes('issuer') && this.issuerApi) {
      const ledger = this.issuerApi.ledgerState
      for (const [keyHash, status] of ledger.issuerStatuses) {
        const publicKey = ledger.issuerKeys.member(keyHash)
          ? ledger.issuerKeys.lookup(keyHash)
          : new Uint8Array(32)
        const name = ledger.issuerNames.member(keyHash) ? ledger.issuerNames.lookup(keyHash) : ''
        yield {
          type: 'issuer',
          publicKeyHash: bytesHex(keyHash),
          status: issuerStatusName(status as number | bigint),
          publicKey: bytesHex(publicKey),
          name,
          ts,
        }
      }
    }
    if (topics.includes('revocation') && this.revocationApi) {
      const ledger = this.revocationApi.ledgerState
      for (const [rootHash, status] of ledger.credentialStatuses) {
        const issuerKeyHash = ledger.credentialIssuers.member(rootHash)
          ? ledger.credentialIssuers.lookup(rootHash)
          : new Uint8Array(32)
        const reason = ledger.credentialReasons.member(rootHash)
          ? ledger.credentialReasons.lookup(rootHash)
          : null
        yield {
          type: 'revocation',
          rootHash: bytesHex(rootHash),
          status: credStatusName(status as number | bigint),
          issuerKeyHash: bytesHex(issuerKeyHash),
          reason,
          ts,
        }
      }
    }
    if (topics.includes('identity') && this.identityApi) {
      const ledger = this.identityApi.ledgerState
      for (const [didHash, commitment] of ledger.commitments) {
        const status = ledger.commitmentStatuses.member(didHash)
          ? ledger.commitmentStatuses.lookup(didHash)
          : 0
        const issuerKeyHash = ledger.commitmentIssuers.member(didHash)
          ? ledger.commitmentIssuers.lookup(didHash)
          : new Uint8Array(32)
        yield {
          type: 'identity',
          didHash: bytesHex(didHash),
          commitment: bytesHex(commitment),
          status: commitmentStatusName(status as number | bigint),
          issuerKeyHash: bytesHex(issuerKeyHash),
          ts,
        }
      }
    }
    if (topics.includes('attestation')) {
      // Replay the union of every joined predicate contract's attestation
      // Set — they all share the verifier-side attest_key recipe, so the
      // consumer's cache doesn't need to know which contract supplied
      // which entry.
      for (const api of this.predicateApis.values()) {
        for (const k of (
          api.ledgerState as PredicateLedgerShape & {
            attestations: Iterable<Uint8Array>
          }
        ).attestations) {
          yield { type: 'attestation', attestKey: bytesHex(k), ts }
        }
      }
    }
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private async joinContract<L, W extends object = Record<string, never>>(
    sharedProviders: Record<string, unknown>,
    publicDataProvider: ReturnType<typeof indexerPublicDataProvider>,
    config: MidnightNodeConfig,
    contractAddress: string,
    tag: string,
    contractDirName: string,
    ContractClass: new (...args: never[]) => unknown,
    ledgerFn: (state: StateValue) => L,
    privateStateId: string,
    initialPrivateState: Record<string, unknown> = {},
    witnesses?: W,
    onChange?: (prev: L | null, next: L) => void,
  ): Promise<ContractAPI<L>> {
    const base = CompiledContract.make(tag, ContractClass as never)
    const compiledContract = witnesses
      ? base.pipe(CompiledContract.withWitnesses(witnesses as never) as never)
      : base.pipe(CompiledContract.withVacantWitnesses as never)

    // Per-contract ZK providers (circuit IDs collide across contracts).
    // Proving is in-process (zkir-v2 WASM) — no proof server.
    const zkConfigProvider = new NodeZkConfigProvider(join(config.managedDir, contractDirName))
    const proofProvider = await createInProcessProofProvider(zkConfigProvider)

    const found = await findDeployedContract(
      { ...sharedProviders, zkConfigProvider, proofProvider } as never,
      { contractAddress, compiledContract, privateStateId, initialPrivateState } as never,
    )

    let currentLedger: L | null = null

    const initialState = await publicDataProvider.queryContractState(contractAddress)
    if (initialState) {
      try {
        const next = ledgerFn(initialState.data.state)
        // Initial snapshot: emit by passing prev=null so consumers can backfill
        // their cache with the full set of currently-known entries.
        onChange?.(null, next)
        currentLedger = next
      } catch {
        /* transitional */
      }
    }

    // contractStateObservable is a one-shot graphql-ws subscription
    // from `@midnight-ntwrk/midnight-js-indexer-public-data-provider`
    // with no built-in retry. If the underlying WebSocket drops the
    // subscription silently stops and `onChange` never fires again —
    // the in-memory ledger ages out vs chain while the rest of the
    // sidecar keeps reporting "healthy". We layer two safety nets on
    // top:
    //   (1) `error` handler re-subscribes with a 1 s back-off so a
    //       transient WS blip is invisible to consumers.
    //   (2) A 30 s polling fallback (`queryContractState`) reconciles
    //       any state we'd miss between subscription drops — covers
    //       the case where graphql-ws silently completes without
    //       error (observed against the preview indexer).
    const subscription = openContractStateSubscription(
      publicDataProvider,
      contractAddress,
      ledgerFn,
      onChange,
      () => currentLedger,
      (next) => {
        currentLedger = next
      },
    )
    const poller = setInterval(async () => {
      try {
        const cs = await publicDataProvider.queryContractState(contractAddress)
        if (!cs) return
        const next = ledgerFn(cs.data.state)
        // `onChange` is responsible for diffing prev vs next; we just
        // hand off the freshest snapshot. If the subscription has
        // delivered the same state already this is a no-op for
        // consumers that compare values; for set-typed ledgers the
        // diff helpers iterate the union so re-emitting is safe.
        onChange?.(currentLedger, next)
        currentLedger = next
      } catch (e) {
        /* transient indexer query failure — next tick retries */
      }
    }, 30_000)
    ;(poller as { unref?: () => void }).unref?.()
    void subscription

    return {
      callTx: found.callTx as Record<string, (...args: unknown[]) => Promise<unknown>>,
      get ledgerState(): L {
        if (!currentLedger) {
          throw new Error(`Ledger state not yet available for ${contractAddress}`)
        }
        return currentLedger
      },
      subscription: {
        unsubscribe(): void {
          clearInterval(poller)
          subscription.unsubscribe()
        },
      },
    }
  }

  private assertContract(api: unknown, name: string): void {
    if (!this.connected) throw new Error('MidnightClient is not connected. Call connect() first.')
    if (!api) throw new Error(`${name} registry not connected`)
  }

  private getContractApi(contract: 'issuer' | 'revocation' | 'identity'): ContractAPI<unknown> {
    this.assertConnected()
    switch (contract) {
      case 'issuer':
        this.assertContract(this.issuerApi, 'Issuer')
        return this.issuerApi!
      case 'revocation':
        this.assertContract(this.revocationApi, 'Revocation')
        return this.revocationApi!
      case 'identity':
        this.assertContract(this.identityApi, 'Identity')
        return this.identityApi!
    }
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error('MidnightClient is not connected. Call connect() first.')
  }
}

// =============================================================================
// Ledger diffing → typed events
//
// Each contract subscription compares the previous ledger snapshot to the
// new one and emits events for added or changed entries on the EventBus.
// `prev === null` is treated as "first observation": every current entry
// is emitted so subscribers can backfill their cache on connect.
// =============================================================================

function bytesHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

function issuerStatusName(s: number | bigint): IssuerEvent['status'] {
  const n = Number(s)
  return n === 1 ? 'ACTIVE' : n === 2 ? 'DEACTIVATED' : 'INACTIVE'
}

function credStatusName(s: number | bigint): RevocationEvent['status'] {
  const n = Number(s)
  return n === 1 ? 'REVOKED' : n === 2 ? 'SUSPENDED' : 'ACTIVE'
}

function commitmentStatusName(s: number | bigint): IdentityEvent['status'] {
  const n = Number(s)
  return n === 1 ? 'ACTIVE' : n === 2 ? 'EXPIRED' : 'INACTIVE'
}

function diffIssuer(prev: IssuerLedger | null, next: IssuerLedger): void {
  for (const [keyHash, status] of next.issuerStatuses) {
    const prevStatus = prev?.issuerStatuses.member(keyHash)
      ? prev.issuerStatuses.lookup(keyHash)
      : undefined
    if (prevStatus === status) continue
    const publicKey = next.issuerKeys.member(keyHash)
      ? next.issuerKeys.lookup(keyHash)
      : new Uint8Array(32)
    const name = next.issuerNames.member(keyHash) ? next.issuerNames.lookup(keyHash) : ''
    eventBus.emit({
      type: 'issuer',
      publicKeyHash: bytesHex(keyHash),
      status: issuerStatusName(status as number | bigint),
      publicKey: bytesHex(publicKey),
      name,
      ts: Date.now(),
    })
  }
}

function diffRevocation(prev: RevocationLedger | null, next: RevocationLedger): void {
  // Iterate union of (prev, next) credential keys so a remove from
  // `credentialStatuses` (rare — reactivate keeps the row) still emits.
  const seen = new Set<string>()
  for (const [rootHash, status] of next.credentialStatuses) {
    seen.add(bytesHex(rootHash))
    const prevStatus = prev?.credentialStatuses.member(rootHash)
      ? prev.credentialStatuses.lookup(rootHash)
      : undefined
    if (prevStatus === status) continue
    const issuerKeyHash = next.credentialIssuers.member(rootHash)
      ? next.credentialIssuers.lookup(rootHash)
      : new Uint8Array(32)
    const reason = next.credentialReasons.member(rootHash)
      ? next.credentialReasons.lookup(rootHash)
      : null
    eventBus.emit({
      type: 'revocation',
      rootHash: bytesHex(rootHash),
      status: credStatusName(status as number | bigint),
      issuerKeyHash: bytesHex(issuerKeyHash),
      reason,
      ts: Date.now(),
    })
  }
  if (!prev) return
  for (const [rootHash] of prev.credentialStatuses) {
    if (seen.has(bytesHex(rootHash))) continue
    eventBus.emit({
      type: 'revocation',
      rootHash: bytesHex(rootHash),
      status: 'ACTIVE',
      issuerKeyHash: bytesHex(new Uint8Array(32)),
      reason: null,
      ts: Date.now(),
    })
  }
}

function diffIdentity(prev: IdentityLedger | null, next: IdentityLedger): void {
  for (const [didHash, commitment] of next.commitments) {
    const status = next.commitmentStatuses.member(didHash)
      ? next.commitmentStatuses.lookup(didHash)
      : 0
    const prevCommitment = prev?.commitments.member(didHash)
      ? prev.commitments.lookup(didHash)
      : undefined
    const prevStatus = prev?.commitmentStatuses.member(didHash)
      ? prev.commitmentStatuses.lookup(didHash)
      : undefined
    const commitmentChanged = !prevCommitment || bytesHex(prevCommitment) !== bytesHex(commitment)
    if (!commitmentChanged && prevStatus === status) continue
    const issuerKeyHash = next.commitmentIssuers.member(didHash)
      ? next.commitmentIssuers.lookup(didHash)
      : new Uint8Array(32)
    eventBus.emit({
      type: 'identity',
      didHash: bytesHex(didHash),
      commitment: bytesHex(commitment),
      status: commitmentStatusName(status as number | bigint),
      issuerKeyHash: bytesHex(issuerKeyHash),
      ts: Date.now(),
    })
  }
}

/** Open a `contractStateObservable` subscription with automatic
 *  re-subscribe on error/completion. Returns the active subscription
 *  handle; callers should call `unsubscribe()` to stop. */
function openContractStateSubscription<L>(
  publicDataProvider: ReturnType<typeof indexerPublicDataProvider>,
  contractAddress: string,
  ledgerFn: (state: StateValue) => L,
  onChange: ((prev: L | null, next: L) => void) | undefined,
  getCurrent: () => L | null,
  setCurrent: (next: L) => void,
): { unsubscribe(): void } {
  let active: { unsubscribe(): void } | null = null
  let stopped = false
  const open = (): void => {
    if (stopped) return
    active = publicDataProvider
      .contractStateObservable(contractAddress, { type: 'latest' })
      .subscribe({
        next: (state: ContractState) => {
          try {
            const next = ledgerFn(state.data.state)
            onChange?.(getCurrent(), next)
            setCurrent(next)
          } catch {
            /* transitional */
          }
        },
        error: () => {
          // The 30 s poller covers data freshness while we back off,
          // so this just rebuilds the subscription quietly.
          if (stopped) return
          setTimeout(open, 1_000)
        },
        complete: () => {
          if (stopped) return
          setTimeout(open, 1_000)
        },
      })
  }
  open()
  return {
    unsubscribe(): void {
      stopped = true
      active?.unsubscribe()
    },
  }
}

function diffPredicate(prev: PredicateLedgerShape | null, next: PredicateLedgerShape): void {
  const before = new Set<string>()
  if (prev) {
    for (const k of (prev as PredicateLedgerShape & { attestations: Iterable<Uint8Array> })
      .attestations) {
      before.add(bytesHex(k))
    }
  }
  for (const k of (next as PredicateLedgerShape & { attestations: Iterable<Uint8Array> })
    .attestations) {
    const hex = bytesHex(k)
    if (before.has(hex)) continue
    eventBus.emit({ type: 'attestation', attestKey: hex, ts: Date.now() })
  }
}
