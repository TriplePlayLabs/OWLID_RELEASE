/**
 * Identity Registry REST routes
 */

import { Hono } from 'hono'
import { getClient, hexToBytes, bytesToHex } from '../client.js'

const identity = new Hono()

/** GET /api/identities/:didHash/commitment - Get identity commitment */
identity.get('/:didHash/commitment', async (c) => {
  const didHash = c.req.param('didHash')
  try {
    const client = getClient()
    const commitment = client.getCommitmentFromLedger(hexToBytes(didHash))
    return c.json({
      didHash,
      commitment: commitment ? bytesToHex(commitment) : null,
      status: client.getCommitmentStatusFromLedger(hexToBytes(didHash)),
    })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

/** POST /api/identities/register - Register an identity commitment */
identity.post('/register', async (c) => {
  try {
    const body = await c.req.json<{
      didHash: string
      commitment: string
      issuerKeyHash: string
    }>()
    const client = getClient()
    await client.registerIdentity(
      hexToBytes(body.didHash),
      hexToBytes(body.commitment),
      hexToBytes(body.issuerKeyHash),
    )
    return c.json({ success: true, message: 'Identity registered on-chain' })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

/** POST /api/identities/:didHash/update - Update identity commitment */
identity.post('/:didHash/update', async (c) => {
  const didHash = c.req.param('didHash')
  try {
    const body = await c.req.json<{
      newCommitment: string
      issuerKeyHash: string
    }>()
    const client = getClient()
    await client.updateCommitment(
      hexToBytes(didHash),
      hexToBytes(body.newCommitment),
      hexToBytes(body.issuerKeyHash),
    )
    return c.json({ success: true, message: 'Commitment updated on-chain' })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

export { identity }
