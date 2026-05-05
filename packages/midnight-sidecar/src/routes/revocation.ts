/**
 * Revocation Registry REST routes
 *
 * rootHash: raw credential root hash (hex, used as-is in contract)
 * issuerPublicKey: raw issuer public key (hex, hashed by client with persistentHash)
 */

import { Hono } from 'hono'
import { getClient, hexToBytes } from '../client.js'

const revocation = new Hono()

/** GET /api/revocations/:rootHash/status - Get credential status */
revocation.get('/:rootHash/status', async (c) => {
  const rootHash = c.req.param('rootHash')
  try {
    const client = getClient()
    const status = client.getCredentialStatusFromLedger(hexToBytes(rootHash))
    return c.json({ rootHash, status })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

/** GET /api/revocations/:rootHash/revoked - Check if credential is revoked */
revocation.get('/:rootHash/revoked', async (c) => {
  const rootHash = c.req.param('rootHash')
  try {
    const client = getClient()
    const revoked = client.isCredentialRevokedFromLedger(hexToBytes(rootHash))
    return c.json({ rootHash, revoked })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

/** POST /api/revocations/revoke - Revoke a credential */
revocation.post('/revoke', async (c) => {
  try {
    const body = await c.req.json<{
      rootHash: string
      issuerKeyHash: string
      reason: string
    }>()
    const client = getClient()
    await client.revokeCredential(
      hexToBytes(body.rootHash),
      hexToBytes(body.issuerKeyHash),
      body.reason,
    )
    return c.json({ success: true, message: 'Credential revoked on-chain' })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

/** POST /api/revocations/suspend - Suspend a credential */
revocation.post('/suspend', async (c) => {
  try {
    const body = await c.req.json<{
      rootHash: string
      issuerKeyHash: string
      reason: string
    }>()
    const client = getClient()
    await client.suspendCredential(
      hexToBytes(body.rootHash),
      hexToBytes(body.issuerKeyHash),
      body.reason,
    )
    return c.json({ success: true, message: 'Credential suspended on-chain' })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

/** POST /api/revocations/:rootHash/reactivate - Reactivate a credential */
revocation.post('/:rootHash/reactivate', async (c) => {
  const rootHash = c.req.param('rootHash')
  try {
    const body = await c.req.json<{ issuerKeyHash: string }>()
    const client = getClient()
    await client.reactivateCredential(hexToBytes(rootHash), hexToBytes(body.issuerKeyHash))
    return c.json({ success: true, message: 'Credential reactivated on-chain' })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

export { revocation }
