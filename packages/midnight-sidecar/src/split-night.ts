#!/usr/bin/env bun
/**
 * NIGHT-split ops script.
 *
 * Splits the sidecar wallet's spendable NIGHT into K UTXOs back to its own
 * address, then registers each for DUST generation. Each NIGHT UTXO backs one
 * independent dust output (ledger: one dust output per `backing_night`), so K
 * UTXOs give the relay pipeline K disjoint dust UTXOs to balance against — it
 * already overlaps broadcasts and only serializes balance+reserve, so this
 * lifts the "one in-flight batch" cap to K without any hot-path change.
 *
 * Irreversible on-chain spend — dry-run by default; pass `--yes` to submit.
 *
 *   MIDNIGHT_WALLET_MNEMONIC=... \
 *   MIDNIGHT_NODE_WS_URL=... MIDNIGHT_INDEXER_URI=... MIDNIGHT_INDEXER_WS_URI=... \
 *   MIDNIGHT_PROOF_SERVER_URI=... MIDNIGHT_NETWORK_ID=preview \
 *   bun run src/split-night.ts --lanes 8 --yes
 */
import * as Rx from 'rxjs'
import {
  createHeadlessWallet,
  createWalletFromMnemonic,
  getWalletBalances,
  registerNightForDust,
  splitNight,
  splitOutputs,
  nightUtxoCount,
  waitForNightUtxoCount,
  waitForSync,
  type HeadlessWallet,
} from './wallet.js'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const lanes = Number(flag('--lanes') ?? 8)
const commit = args.includes('--yes')

// Seed (local devnet genesis `0…01`) OR mnemonic (preview), mirroring the
// sidecar's own wallet factory in client.ts.
const mnemonic = process.env.MIDNIGHT_WALLET_MNEMONIC
const seed = process.env.MIDNIGHT_WALLET_SEED
if (!mnemonic && !seed) {
  console.error('Set MIDNIGHT_WALLET_MNEMONIC or MIDNIGHT_WALLET_SEED')
  process.exit(1)
}
if (!Number.isInteger(lanes) || lanes < 2) {
  console.error('--lanes must be an integer >= 2')
  process.exit(1)
}

const networkId = process.env.MIDNIGHT_NETWORK_ID ?? 'preview'
const walletConfig = {
  nodeWsUrl: process.env.MIDNIGHT_NODE_WS_URL!,
  indexerUrl: process.env.MIDNIGHT_INDEXER_URI!,
  indexerWsUrl: process.env.MIDNIGHT_INDEXER_WS_URI!,
  proofServerUrl: process.env.MIDNIGHT_PROOF_SERVER_URI!,
  networkId,
}

const splitConfirmTimeoutMs = Number(process.env.SPLIT_CONFIRM_TIMEOUT_MS ?? 180_000)

async function main() {
  console.log(`=== OwlID NIGHT split (${networkId}) — lanes=${lanes}, commit=${commit} ===\n`)

  const wallet: HeadlessWallet = mnemonic
    ? await createWalletFromMnemonic(mnemonic.trim(), walletConfig)
    : await createHeadlessWallet({ ...walletConfig, seed: seed! })
  try {
    // Read balance/UTXOs only after the wallet is synced, else `availableCoins`
    // is empty and we'd misjudge the split.
    await waitForSync(wallet.facade)
    const before = await getWalletBalances(wallet, networkId)
    const state0 = await Rx.firstValueFrom(wallet.facade.state())
    console.log(`address:           ${before.unshieldedAddr}`)
    console.log(`NIGHT (unshielded): ${before.unshielded}`)
    console.log(`DUST:               ${before.dust}`)
    console.log(`NIGHT UTXOs now:    ${nightUtxoCount(state0)}`)

    // Idempotent: if the wallet already carries >= `lanes` NIGHT UTXOs it has
    // enough dust lanes — re-register any unregistered ones and stop, so a
    // re-run never keeps fragmenting NIGHT into ever-smaller pieces.
    if (nightUtxoCount(state0) >= lanes) {
      console.log(`\nAlready has >= ${lanes} NIGHT UTXOs — no split needed.`)
      if (commit) {
        console.log('Ensuring all are registered for dust...')
        await registerNightForDust(wallet)
        const after = await getWalletBalances(wallet, networkId)
        console.log(`DONE. NIGHT=${after.unshielded} DUST=${after.dust}`)
      } else {
        console.log('Dry run — would register any unregistered UTXOs for dust.')
      }
      return
    }

    if (before.unshielded <= 0n) throw new Error('wallet has no spendable NIGHT to split')
    if (before.dust <= 0n) throw new Error('wallet has no DUST to pay the split + register fees')

    const plan = splitOutputs(before.unshielded, lanes)
    console.log(`\nplan: ${lanes} outputs to self:`)
    plan.forEach((a, i) => console.log(`  lane ${i + 1}: ${a}`))

    if (!commit) {
      console.log('\nDry run (no --yes). Nothing submitted.')
      return
    }

    console.log('\nSubmitting split tx...')
    const txId = await splitNight(wallet, before.unshielded, lanes)
    console.log(`  split submitted: ${txId}`)
    // `waitForFunds` only waits for a non-zero balance, which is already true —
    // it returns before the split's outputs leave the pending set. Poll until
    // the `lanes` new UTXOs actually land in availableCoins, else we'd register
    // zero UTXOs (the outputs are still pending) and leave the lanes unfunded.
    const landed = await waitForNightUtxoCount(wallet, lanes, splitConfirmTimeoutMs)
    console.log(`  NIGHT UTXOs after split: ${landed}`)
    if (landed < lanes) {
      throw new Error(
        `only ${landed}/${lanes} split UTXOs confirmed within ${splitConfirmTimeoutMs}ms — ` +
          're-run (idempotent) once they settle, or raise SPLIT_CONFIRM_TIMEOUT_MS',
      )
    }

    console.log('\nRegistering NIGHT UTXOs for DUST generation...')
    await registerNightForDust(wallet)

    const after = await getWalletBalances(wallet, networkId)
    const state2 = await Rx.firstValueFrom(wallet.facade.state())
    console.log(
      `\nDONE. NIGHT=${after.unshielded} DUST=${after.dust} UTXOs=${nightUtxoCount(state2)}`,
    )
    console.log('Dust generation takes a few minutes to accrue per new UTXO.')
  } finally {
    await wallet.close()
  }
}

main().catch((e) => {
  console.error('\nsplit-night failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
