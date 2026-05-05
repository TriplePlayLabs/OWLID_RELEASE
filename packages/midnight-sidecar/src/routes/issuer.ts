/**
 * Issuer Registry REST routes
 *
 * All endpoints accept the issuer's raw public key (hex).
 * The client hashes it with persistentHash internally for ledger lookups.
 */

import { Hono } from 'hono'
import { getClient, hexToBytes, bytesToHex } from '../client.js'

const issuer = new Hono()

/** GET /api/issuers/:publicKey/status - Get issuer status */
issuer.get('/:publicKey/status', async (c) => {
  const publicKey = c.req.param('publicKey')
  try {
    const client = getClient()
    const status = client.getIssuerStatusFromLedger(hexToBytes(publicKey))
    return c.json({ publicKey, status })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

/** GET /api/issuers/:publicKey/trusted - Check if issuer is trusted */
issuer.get('/:publicKey/trusted', async (c) => {
  const publicKey = c.req.param('publicKey')
  try {
    const client = getClient()
    const trusted = client.isIssuerTrustedFromLedger(hexToBytes(publicKey))
    return c.json({ publicKey, trusted })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

/** POST /api/issuers/register - Register a new issuer */
issuer.post('/register', async (c) => {
  try {
    const body = await c.req.json<{ publicKey: string; name: string }>()
    const client = getClient()
    await client.registerIssuer(hexToBytes(body.publicKey), body.name)
    return c.json({ success: true, message: 'Issuer registered on-chain' })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

/** POST /api/issuers/:publicKey/deactivate - Deactivate an issuer */
issuer.post('/:publicKey/deactivate', async (c) => {
  const publicKey = c.req.param('publicKey')
  try {
    const client = getClient()
    await client.deactivateIssuer(hexToBytes(publicKey))
    return c.json({ success: true, message: 'Issuer deactivated on-chain' })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

export { issuer }
