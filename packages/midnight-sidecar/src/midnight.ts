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
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider'
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

import { createIdentityRegistryWitnesses } from './witnesses.js'

// =============================================================================
// Types
// =============================================================================

export interface ContractAddresses {
  issuerRegistry?: string
  revocationRegistry?: string
  identityRegistry?: string
}

export interface MidnightNodeConfig {
  indexerUri: string
  indexerWsUri: string
  proofServerUri: string
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
      )
    }

    this.connected = true
  }

  disconnect(): void {
    this.issuerApi?.subscription.unsubscribe()
    this.revocationApi?.subscription.unsubscribe()
    this.identityApi?.subscription.unsubscribe()
    this.issuerApi = null
    this.revocationApi = null
    this.identityApi = null
    this.connected = false
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
    await this.issuerApi!.callTx.registerIssuer(publicKey, name)
  }

  async deactivateIssuer(publicKey: Uint8Array): Promise<void> {
    this.assertContract(this.issuerApi, 'Issuer')
    const keyHash = this.issuerKeyHash(publicKey)
    await this.issuerApi!.callTx.deactivateIssuer(keyHash)
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
    await this.revocationApi!.callTx.revoke(rootHash, issuerKeyHash, reason)
  }

  async suspendCredential(
    rootHash: Uint8Array,
    issuerPublicKey: Uint8Array,
    reason: string,
  ): Promise<void> {
    this.assertContract(this.revocationApi, 'Revocation')
    const issuerKeyHash = this.issuerKeyHash(issuerPublicKey)
    await this.revocationApi!.callTx.suspend(rootHash, issuerKeyHash, reason)
  }

  async reactivateCredential(rootHash: Uint8Array, issuerPublicKey: Uint8Array): Promise<void> {
    this.assertContract(this.revocationApi, 'Revocation')
    const issuerKeyHash = this.issuerKeyHash(issuerPublicKey)
    await this.revocationApi!.callTx.reactivate(rootHash, issuerKeyHash)
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
    await this.identityApi!.callTx.registerIdentity(didHash, commitment, issuerKeyHash)
  }

  async updateCommitment(
    didHash: Uint8Array,
    newCommitment: Uint8Array,
    issuerKeyHash: Uint8Array,
  ): Promise<void> {
    this.assertContract(this.identityApi, 'Identity')
    if (!this.ownerSecretKey)
      throw new Error('Owner secret key not set. Call setOwnerSecretKey() first.')
    await this.identityApi!.callTx.updateCommitment(didHash, newCommitment, issuerKeyHash)
  }

  async getCommitment(didHash: Uint8Array): Promise<Uint8Array> {
    this.assertContract(this.identityApi, 'Identity')
    return (await this.identityApi!.callTx.getCommitment(didHash)) as Uint8Array
  }

  // =========================================================================
  // Admin
  // =========================================================================

  async pauseContract(contract: 'issuer' | 'revocation' | 'identity'): Promise<void> {
    await this.getContractApi(contract).callTx.pause()
  }

  async unpauseContract(contract: 'issuer' | 'revocation' | 'identity'): Promise<void> {
    await this.getContractApi(contract).callTx.unpause()
  }

  isContractPaused(contract: 'issuer' | 'revocation' | 'identity'): boolean {
    return (this.getContractApi(contract).ledgerState as Record<string, unknown>).paused as boolean
  }

  async adminUpdateCommitment(
    didHash: Uint8Array,
    newCommitment: Uint8Array,
    issuerKeyHash: Uint8Array,
  ): Promise<void> {
    this.assertContract(this.identityApi, 'Identity')
    await this.identityApi!.callTx.adminUpdateCommitment(didHash, newCommitment, issuerKeyHash)
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
  ): Promise<ContractAPI<L>> {
    const base = CompiledContract.make(tag, ContractClass as never)
    const compiledContract = witnesses
      ? base.pipe(CompiledContract.withWitnesses(witnesses as never) as never)
      : base.pipe(CompiledContract.withVacantWitnesses as never)

    // Per-contract ZK providers (circuit IDs collide across contracts)
    const zkConfigProvider = new NodeZkConfigProvider(join(config.managedDir, contractDirName))
    const proofProvider = httpClientProofProvider(config.proofServerUri, zkConfigProvider)

    const found = await findDeployedContract(
      { ...sharedProviders, zkConfigProvider, proofProvider } as never,
      { contractAddress, compiledContract, privateStateId, initialPrivateState } as never,
    )

    let currentLedger: L | null = null

    const initialState = await publicDataProvider.queryContractState(contractAddress)
    if (initialState) {
      try {
        currentLedger = ledgerFn(initialState.data.state)
      } catch {
        /* transitional */
      }
    }

    const subscription = publicDataProvider
      .contractStateObservable(contractAddress, { type: 'latest' })
      .subscribe((state: ContractState) => {
        try {
          currentLedger = ledgerFn(state.data.state)
        } catch {
          /* transitional */
        }
      })

    return {
      callTx: found.callTx as Record<string, (...args: unknown[]) => Promise<unknown>>,
      get ledgerState(): L {
        if (!currentLedger) {
          throw new Error(`Ledger state not yet available for ${contractAddress}`)
        }
        return currentLedger
      },
      subscription,
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
