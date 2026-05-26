/**
 * Revocation Registry REST routes.
 *
 * Body conventions:
 *   rootHash         — raw credential root hash (hex, 32 bytes), used as-is on chain.
 *   issuerPublicKey  — raw issuer Ed25519 public key (hex, 32 bytes); the
 *                      sidecar hashes it once with persistentHash<Bytes<32>>
 *                      before submitting, matching what the issuer registry
 *                      stores. Pass the raw key, NOT a pre-hashed value.
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

/**
 * GET /api/revocations/:rootHash/inclusion
 * Submits a `proveRevocationInclusion` transaction whose witness pulls
 * the Merkle path from the contract's `revokedTree`. Succeeds iff the
 * root hash has been revoked at some point. Costs DUST.
 */
revocation.get('/:rootHash/inclusion', async (c) => {
  const rootHash = c.req.param('rootHash')
  try {
    const client = getClient()
    await client.proveRevocationInclusion(hexToBytes(rootHash))
    return c.json({ rootHash, included: true })
  } catch (e) {
    return c.json({ rootHash, included: false, error: String(e) }, 200)
  }
})

/** POST /api/revocations/revoke - Revoke a credential */
revocation.post('/revoke', async (c) => {
  try {
    const body = await c.req.json<{
      rootHash: string
      issuerPublicKey: string
      reason: string
    }>()
    const client = getClient()
    await client.revokeCredential(
      hexToBytes(body.rootHash),
      hexToBytes(body.issuerPublicKey),
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
      issuerPublicKey: string
      reason: string
    }>()
    const client = getClient()
    await client.suspendCredential(
      hexToBytes(body.rootHash),
      hexToBytes(body.issuerPublicKey),
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
    const body = await c.req.json<{ issuerPublicKey: string }>()
    const client = getClient()
    await client.reactivateCredential(hexToBytes(rootHash), hexToBytes(body.issuerPublicKey))
    return c.json({ success: true, message: 'Credential reactivated on-chain' })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

export { revocation }
