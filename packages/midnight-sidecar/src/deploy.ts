#!/usr/bin/env bun
/**
 * Contract Deployment Script
 *
 * Deploys the 3 OwlID Compact contracts to a Midnight network:
 *   1. Issuer Registry
 *   2. Revocation Registry
 *   3. Identity Registry
 *
 * Usage:
 *   MIDNIGHT_WALLET_SEED=<seed> bun run src/deploy.ts
 *
 * For local devnet:
 *   MIDNIGHT_WALLET_SEED=0000000000000000000000000000000000000000000000000000000000000001 \
 *   bun run src/deploy.ts
 *
 * Outputs deployed contract addresses to stdout and writes them to .env.contracts
 */

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts'
import { CompiledContract } from '@midnight-ntwrk/compact-js'
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider'
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider'
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider'

import { Contract as IssuerContract } from '../managed/issuer_registry/contract/index.js'
import { Contract as RevocationContract } from '../managed/revocation_registry/contract/index.js'
import { Contract as IdentityContract } from '../managed/identity_registry/contract/index.js'

import {
  createHeadlessWallet,
  DEVNET_GENESIS_SEED,
  getWalletBalances,
  registerNightForDust,
} from './wallet.js'
import { createIdentityRegistryWitnesses } from './witnesses.js'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'

// Configuration from environment
const seed = process.env.MIDNIGHT_WALLET_SEED ?? DEVNET_GENESIS_SEED
const nodeWsUrl = process.env.MIDNIGHT_NODE_WS_URL ?? 'ws://localhost:9944'
const indexerUrl = process.env.MIDNIGHT_INDEXER_URI ?? 'http://localhost:8088/api/v3/graphql'
const indexerWsUrl = process.env.MIDNIGHT_INDEXER_WS_URI ?? 'ws://localhost:8088/api/v3/graphql/ws'
const proofServerUrl = process.env.MIDNIGHT_PROOF_SERVER_URI ?? 'http://localhost:6300'
const networkId = process.env.MIDNIGHT_NETWORK_ID ?? 'undeployed'

// Path to compiled contract assets (contains zkir/ directories)
const contractsBase = join(import.meta.dir, '..', 'managed')

async function main() {
  console.log('=== OwlID Contract Deployment ===')
  console.log(`Network:      ${networkId}`)
  console.log(`Node:         ${nodeWsUrl}`)
  console.log(`Indexer:      ${indexerUrl}`)
  console.log(`Proof Server: ${proofServerUrl}`)
  console.log()

  // 1. Create headless wallet
  console.log('[1/5] Creating headless wallet...')
  const wallet = await createHeadlessWallet({
    seed,
    nodeWsUrl,
    indexerUrl,
    indexerWsUrl,
    proofServerUrl,
    networkId,
  })
  console.log(`  coinPublicKey: ${wallet.coinPublicKey.slice(0, 32)}...`)

  const balances = await getWalletBalances(wallet, networkId)
  console.log(`  NIGHT balance: ${balances.unshielded + balances.shielded}`)
  console.log(`  DUST balance:  ${balances.dust}`)
  if (balances.dust === 0n) {
    console.log('  Registering NIGHT UTXOs for DUST generation...')
    await registerNightForDust(wallet)
  }
  console.log()

  // 2. Set up providers
  console.log('[2/5] Setting up providers...')

  const walletProvider = {
    getCoinPublicKey: () => wallet.coinPublicKey,
    getEncryptionPublicKey: () => wallet.encryptionPublicKey,
    balanceTx: wallet.balanceTx,
  }

  const midnightProvider = {
    submitTx: wallet.submitTx,
  }

  // Generate a secret key for the identity registry owner
  const ownerSecretKey = randomBytes(32)

  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'owlid-deploy-state',
      privateStoragePasswordProvider: () =>
        process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD ?? 'Owlid-Deploy#2026!local',
      accountId: 'deploy',
    }),
    publicDataProvider: indexerPublicDataProvider(indexerUrl, indexerWsUrl),
    zkConfigProvider: undefined as any, // will be set per-contract
    proofProvider: undefined as any, // will be set per-contract
    walletProvider,
    midnightProvider,
  }

  // Create the initial owner argument for contract constructors
  // Owner is Either<ZswapCoinPublicKey, ContractAddress> — use left (coin public key)
  const coinPubKeyBytes = Buffer.from(wallet.coinPublicKey, 'hex')
  const initialOwner = {
    is_left: true,
    left: { bytes: new Uint8Array(coinPubKeyBytes) },
    right: { bytes: new Uint8Array(32) }, // dummy for right side
  }

  console.log('  Providers ready.')
  console.log()

  const addresses: Record<string, string> = {}

  // 3. Deploy contracts
  console.log('[3/5] Deploying contracts...')
  console.log()

  // Deploy Issuer Registry
  console.log('  Deploying Issuer Registry...')
  try {
    const zkConfigProvider = new NodeZkConfigProvider(join(contractsBase, 'issuer_registry'))
    const compiledContract = CompiledContract.make('issuer-registry', IssuerContract).pipe(
      CompiledContract.withVacantWitnesses,
      CompiledContract.withCompiledFileAssets(join(contractsBase, 'issuer_registry')),
    )
    const deployed = await (deployContract as Function)(
      {
        ...providers,
        zkConfigProvider,
        proofProvider: httpClientProofProvider(proofServerUrl, zkConfigProvider),
      },
      {
        compiledContract,
        privateStateId: 'owlid-issuer-registry',
        initialPrivateState: {},
        args: [initialOwner],
      },
    )
    addresses.issuerRegistry = deployed.deployTxData.public.contractAddress
    console.log(`  Issuer Registry:     ${addresses.issuerRegistry}`)
  } catch (e: any) {
    console.error('  Failed to deploy Issuer Registry:', e.message ?? e)
    if (e.stack) console.error('  ', e.stack.split('\n').slice(0, 3).join('\n  '))
  }

  // Deploy Revocation Registry
  console.log('  Deploying Revocation Registry...')
  try {
    const zkConfigProvider = new NodeZkConfigProvider(join(contractsBase, 'revocation_registry'))
    const compiledContract = CompiledContract.make('revocation-registry', RevocationContract).pipe(
      CompiledContract.withVacantWitnesses,
      CompiledContract.withCompiledFileAssets(join(contractsBase, 'revocation_registry')),
    )
    const deployed = await (deployContract as Function)(
      {
        ...providers,
        zkConfigProvider,
        proofProvider: httpClientProofProvider(proofServerUrl, zkConfigProvider),
      },
      {
        compiledContract,
        privateStateId: 'owlid-revocation-registry',
        initialPrivateState: {},
        args: [initialOwner],
      },
    )
    addresses.revocationRegistry = deployed.deployTxData.public.contractAddress
    console.log(`  Revocation Registry: ${addresses.revocationRegistry}`)
  } catch (e: any) {
    console.error('  Failed to deploy Revocation Registry:', e.message ?? e)
    if (e.stack) console.error('  ', e.stack.split('\n').slice(0, 3).join('\n  '))
  }

  // Deploy Identity Registry (requires ownerSecretKey witness)
  console.log('  Deploying Identity Registry...')
  try {
    const zkConfigProvider = new NodeZkConfigProvider(join(contractsBase, 'identity_registry'))
    const witnesses = createIdentityRegistryWitnesses(ownerSecretKey)
    const compiledContract = CompiledContract.make('identity-registry', IdentityContract).pipe(
      CompiledContract.withWitnesses(witnesses),
      CompiledContract.withCompiledFileAssets(join(contractsBase, 'identity_registry')),
    )
    const deployed = await (deployContract as Function)(
      {
        ...providers,
        zkConfigProvider,
        proofProvider: httpClientProofProvider(proofServerUrl, zkConfigProvider),
      },
      {
        compiledContract,
        privateStateId: 'owlid-identity-registry',
        initialPrivateState: { secretKey: ownerSecretKey },
        args: [initialOwner],
      },
    )
    addresses.identityRegistry = deployed.deployTxData.public.contractAddress
    console.log(`  Identity Registry:   ${addresses.identityRegistry}`)
  } catch (e: any) {
    console.error('  Failed to deploy Identity Registry:', e.message ?? e)
    if (e.stack) console.error('  ', e.stack.split('\n').slice(0, 3).join('\n  '))
  }

  console.log()

  // 4. Write output
  console.log('[4/5] Writing contract addresses...')

  // Update .env with deployed contract addresses
  const envPath = join(import.meta.dir, '..', '..', '..', '.env')
  const { readFileSync } = await import('fs')
  let envContent = readFileSync(envPath, 'utf-8')

  const replacements: Record<string, string> = {
    MIDNIGHT_ISSUER_REGISTRY_ADDRESS: addresses.issuerRegistry ?? '',
    MIDNIGHT_REVOCATION_REGISTRY_ADDRESS: addresses.revocationRegistry ?? '',
    MIDNIGHT_IDENTITY_REGISTRY_ADDRESS: addresses.identityRegistry ?? '',
    MIDNIGHT_OWNER_SECRET_KEY: ownerSecretKey.toString('hex'),
  }

  for (const [key, value] of Object.entries(replacements)) {
    envContent = envContent.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`)
  }

  writeFileSync(envPath, envContent)
  console.log(`  Updated: ${envPath}`)
  console.log()

  // Print summary
  console.log('=== Deployment Complete ===')
  console.log()
  console.log('Contract addresses:')
  for (const [name, addr] of Object.entries(addresses)) {
    console.log(`  ${name}: ${addr}`)
  }

  // Cleanup
  wallet.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('Deployment failed:', e)
  process.exit(1)
})
