/**
 * Midnight Sidecar Service
 *
 * HTTP bridge between Rust backend services and the Midnight blockchain.
 * Provides REST API for contract reads/writes, with API key authentication.
 */

import { Hono } from 'hono'
import { loadConfig } from './config.js'
import { initClient, getClient, disconnectClient } from './client.js'
import { issuer } from './routes/issuer.js'
import { revocation } from './routes/revocation.js'
import { identity } from './routes/identity.js'

const app = new Hono()

// Load config
const config = loadConfig()

// API key auth middleware for /api/* routes
app.use('/api/*', async (c, next) => {
  const apiKey = c.req.header('X-API-Key')
  if (!apiKey || apiKey !== config.apiKey) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  await next()
})

// Mount route groups
app.route('/api/issuers', issuer)
app.route('/api/revocations', revocation)
app.route('/api/identities', identity)

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
  if (config.issuerRegistryAddress) console.log(`  Issuer:     ${config.issuerRegistryAddress}`)
  if (config.revocationRegistryAddress)
    console.log(`  Revocation: ${config.revocationRegistryAddress}`)
  if (config.identityRegistryAddress) console.log(`  Identity:   ${config.identityRegistryAddress}`)
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

export default {
  port: config.port,
  fetch: app.fetch,
}
