#!/usr/bin/env bun
/**
 * Account Funding Script
 *
 * Funds Midnight accounts with NIGHT tokens from the genesis wallet,
 * then registers them for DUST generation.
 *
 * Usage:
 *   # Fund accounts from accounts.json config file
 *   bun run src/fund-accounts.ts --config accounts.json
 *
 *   # Fund a specific address with NIGHT tokens only
 *   bun run src/fund-accounts.ts --address <bech32_address>
 *
 * For local devnet, the genesis wallet (seed 0...01) has pre-minted tokens.
 */

import { readFile } from 'node:fs/promises'
import {
  createHeadlessWallet,
  createWalletFromMnemonic,
  waitForSync,
  waitForFunds,
  getWalletBalances,
  registerNightForDust,
  transferNight,
  DEVNET_GENESIS_SEED,
  type HeadlessWallet,
} from './wallet.js'
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format'

const NIGHT_AMOUNT = 50_000n * 10n ** 6n // 50,000 NIGHT in smallest unit

interface AccountConfig {
  name: string
  mnemonic: string
}

interface AccountsFile {
  accounts: AccountConfig[]
}

// Parse CLI args
const args = process.argv.slice(2)
const configPath = args.includes('--config') ? args[args.indexOf('--config') + 1] : undefined
const addressArg = args.includes('--address') ? args[args.indexOf('--address') + 1] : undefined

if (!configPath && !addressArg) {
  console.error('Usage:')
  console.error('  bun run src/fund-accounts.ts --config accounts.json')
  console.error('  bun run src/fund-accounts.ts --address <bech32_address>')
  process.exit(1)
}

// Network config from env
const seed = process.env.MIDNIGHT_WALLET_SEED ?? DEVNET_GENESIS_SEED
const nodeWsUrl = process.env.MIDNIGHT_NODE_WS_URL ?? 'ws://localhost:9944'
const indexerUrl = process.env.MIDNIGHT_INDEXER_URI ?? 'http://localhost:8088/api/v3/graphql'
const indexerWsUrl = process.env.MIDNIGHT_INDEXER_WS_URI ?? 'ws://localhost:8088/api/v3/graphql/ws'
const proofServerUrl = process.env.MIDNIGHT_PROOF_SERVER_URI ?? 'http://localhost:6300'
const networkId = process.env.MIDNIGHT_NETWORK_ID ?? 'undeployed'

const walletConfig = { nodeWsUrl, indexerUrl, indexerWsUrl, proofServerUrl, networkId }

async function main() {
  console.log('=== OwlID Account Funding ===')
  console.log(`Network: ${networkId}`)
  console.log()

  // Initialize master wallet (genesis)
  console.log('[1] Initializing genesis wallet...')
  const masterWallet = await createHeadlessWallet({
    ...walletConfig,
    seed,
  })

  const masterBalances = await getWalletBalances(masterWallet, networkId)
  console.log(`  Address:  ${masterBalances.unshieldedAddr}`)
  console.log(`  NIGHT:    ${masterBalances.unshielded + masterBalances.shielded}`)
  console.log(`  DUST:     ${masterBalances.dust}`)
  console.log()

  // Ensure master has DUST
  if (masterBalances.dust === 0n) {
    console.log('[1b] Registering genesis wallet for DUST...')
    await registerNightForDust(masterWallet)
    console.log()
  }

  if (configPath) {
    await fundFromConfig(masterWallet, configPath)
  } else if (addressArg) {
    await fundAddress(masterWallet, addressArg)
  }

  await masterWallet.close()
  console.log('\n=== Done ===')
  process.exit(0)
}

async function fundFromConfig(masterWallet: HeadlessWallet, path: string) {
  const raw = await readFile(path, 'utf-8')
  const accountsFile: AccountsFile = JSON.parse(raw)

  if (!accountsFile.accounts?.length) {
    throw new Error('Invalid config file: must have an "accounts" array')
  }

  console.log(`[2] Funding ${accountsFile.accounts.length} accounts...\n`)

  for (let i = 0; i < accountsFile.accounts.length; i++) {
    const account = accountsFile.accounts[i]
    console.log(`--- Account ${i + 1}/${accountsFile.accounts.length}: ${account.name} ---`)

    // Create recipient wallet from mnemonic
    const recipientWallet = await createWalletFromMnemonic(account.mnemonic, walletConfig)
    const recipientAddress = await recipientWallet.facade.unshielded.getAddress()

    // Transfer NIGHT
    console.log(`  Transferring ${NIGHT_AMOUNT} NIGHT...`)
    const txId = await transferNight(masterWallet, recipientAddress, NIGHT_AMOUNT)
    console.log(`  Transfer submitted: ${txId}`)

    // Wait for funds to arrive
    await waitForFunds(recipientWallet.facade)
    const balances = await getWalletBalances(recipientWallet, networkId)
    console.log(`  NIGHT received: ${balances.unshielded + balances.shielded}`)

    // Register DUST
    console.log('  Registering DUST...')
    await registerNightForDust(recipientWallet)

    const finalBalances = await getWalletBalances(recipientWallet, networkId)
    console.log(
      `  Final NIGHT: ${finalBalances.unshielded + finalBalances.shielded}, DUST: ${finalBalances.dust}`,
    )

    await recipientWallet.close()
    console.log(`  ${account.name} funded.\n`)
  }
}

async function fundAddress(masterWallet: HeadlessWallet, addressStr: string) {
  console.log(`[2] Funding address: ${addressStr}\n`)

  const parsed = MidnightBech32m.parse(addressStr)
  const unshieldedAddress = UnshieldedAddress.codec.decode(networkId as any, parsed)

  console.log(`  Transferring ${NIGHT_AMOUNT} NIGHT...`)
  const txId = await transferNight(masterWallet, unshieldedAddress, NIGHT_AMOUNT)
  console.log(`  Transfer submitted: ${txId}`)
  console.log('  (DUST not registered — recipient must do it themselves)')
}

main().catch((e) => {
  console.error('Funding failed:', e)
  process.exit(1)
})
