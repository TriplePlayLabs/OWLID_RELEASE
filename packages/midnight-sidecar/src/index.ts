/**
 * Midnight Sidecar Service
 *
 * HTTP bridge between Rust backend services and the Midnight blockchain.
 * Provides REST API for contract reads/writes, with API key authentication.
 */

import { Hono } from 'hono'
import { loadConfig } from './config.js'
import { initClient, getClient, getWalletSupervisor, disconnectClient } from './client.js'
import { issuer } from './routes/issuer.js'
import { revocation } from './routes/revocation.js'
import { identity } from './routes/identity.js'
import { predicates } from './routes/predicates.js'
import { events } from './routes/events.js'

const app = new Hono()

// Load config
const config = loadConfig()

// API key auth middleware for /api/* and /events routes
const auth = async (c: Parameters<Parameters<typeof app.use>[1]>[0], next: () => Promise<void>) => {
  const header = c.req.header('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token || token !== config.apiKey) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  await next()
}
app.use('/api/*', auth)
app.use('/events', auth)

// Mount route groups
app.route('/api/issuers', issuer)
app.route('/api/revocations', revocation)
app.route('/api/identities', identity)
app.route('/api/predicates', predicates)
app.route('/events', events)

// Health check (no auth required)
app.get('/health', async (c) => {
  try {
    const client = getClient()
    return c.json({
      status: 'ok',
      connected: client.isConnected(),
      contracts: {
        issuerRegistry: !!config.issuerRegistryAddress,
        revocationRegistry: !!config.revocationRegistryAddress,
        identityRegistry: !!config.identityRegistryAddress,
      },
    })
  } catch {
    return c.json({
      status: 'degraded',
      connected: false,
      error: 'MidnightClient not connected',
    })
  }
})

// Wallet health — live sync/dust state + supervisor status (no auth).
app.get('/health/wallet', async (c) => {
  const supervisor = getWalletSupervisor()
  if (!supervisor) return c.json({ error: 'no wallet (read-only mode)' }, 503)
  try {
    return c.json(await supervisor.snapshot())
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

// Startup
async function start() {
  console.log(`[sidecar] Starting Midnight Sidecar on port ${config.port}...`)

  try {
    await initClient(config)
    console.log('[sidecar] MidnightClient connected')
  } catch (e) {
    console.error('[sidecar] Failed to connect MidnightClient:', e)
    console.warn('[sidecar] Starting in degraded mode - health endpoint will report disconnected')
  }

  console.log(`[sidecar] Listening on http://localhost:${config.port}`)
  console.log('[sidecar] Contracts:')
  if (config.issuerRegistryAddress) console.log(`  Issuer:        ${config.issuerRegistryAddress}`)
  if (config.revocationRegistryAddress)
    console.log(`  Revocation:    ${config.revocationRegistryAddress}`)
  if (config.identityRegistryAddress)
    console.log(`  Identity:      ${config.identityRegistryAddress}`)
  for (const [kind, addr] of Object.entries(config.predicateAddresses)) {
    if (addr) console.log(`  Predicate ${kind.padEnd(11)} ${addr}`)
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[sidecar] Shutting down...')
  disconnectClient()
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('[sidecar] Shutting down...')
  disconnectClient()
  process.exit(0)
})

start()

// Some routes (revoke / proveRevocationInclusion / etc.) submit a
// Compact transaction that must be proven, balanced, broadcast, and
// finalized — readily exceeding Bun's 10-second default idle timeout.
const REQUEST_TIMEOUT_SECONDS = 240

export default {
  port: config.port,
  fetch: app.fetch,
  idleTimeout: REQUEST_TIMEOUT_SECONDS,
}
