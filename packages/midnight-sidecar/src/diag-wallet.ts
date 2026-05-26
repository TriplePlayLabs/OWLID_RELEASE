#!/usr/bin/env bun
import { createWalletFromMnemonic, getWalletBalances } from './wallet.js'
import * as Rx from 'rxjs'

const mnemonic = process.env.MIDNIGHT_WALLET_MNEMONIC!
const networkId = process.env.MIDNIGHT_NETWORK_ID ?? 'preview'
const walletConfig = {
  nodeWsUrl: process.env.MIDNIGHT_NODE_WS_URL!,
  indexerUrl: process.env.MIDNIGHT_INDEXER_URI!,
  indexerWsUrl: process.env.MIDNIGHT_INDEXER_WS_URI!,
  proofServerUrl: process.env.MIDNIGHT_PROOF_SERVER_URI!,
  networkId,
}

const w = await createWalletFromMnemonic(mnemonic.trim(), walletConfig)
const b = await getWalletBalances(w, networkId)
console.log('=== DERIVED WALLET ===')
console.log('unshieldedAddr:', b.unshieldedAddr)
console.log('shieldedAddr:  ', b.shieldedAddr)
console.log('dustAddr:      ', b.dustAddr)
console.log('NIGHT unshielded:', b.unshielded)
console.log('NIGHT shielded:  ', b.shielded)
console.log('DUST:            ', b.dust)

const state = await Rx.firstValueFrom(w.facade.state())
const coins = (state as any).unshielded?.availableCoins ?? []
console.log('=== UNSHIELDED UTXOs ===', coins.length)
for (const c of coins) {
  console.log(
    '  amount:',
    c.value ?? c.amount,
    'registeredForDust:',
    c.meta?.registeredForDustGeneration,
  )
}
console.log('=== DUST STATE ===')
console.log('dust subwallet present:', !!(state as any).dust)
console.log('isSynced:', (state as any).isSynced)
await w.close()
process.exit(0)
