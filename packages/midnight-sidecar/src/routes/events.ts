/**
 * Server-Sent Events stream of chain-state changes.
 *
 * Connection lifecycle:
 *   1. On connect, the server emits a snapshot of every currently-known
 *      entry across the three contracts (revocation, issuer, identity)
 *      so the client can rebuild its cache from cold.
 *   2. The connection then tails the in-process EventBus, which emits
 *      one JSON line per state change observed by the contract
 *      subscriptions (see midnight.ts).
 *
 * Each SSE event is JSON: `{type: 'revocation'|'issuer'|'identity', ...}`.
 * Scope filter via query string: `?topics=revocation,issuer`.
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getClient } from '../client.js'
import { eventBus, type SidecarEvent } from '../events.js'

const events = new Hono()

events.get('/', (c) => {
  const topics = (c.req.query('topics') ?? 'revocation,issuer,identity,attestation')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean) as Array<SidecarEvent['type']>

  return streamSSE(c, async (stream) => {
    let id = 0
    const send = async (e: SidecarEvent): Promise<void> => {
      if (!topics.includes(e.type)) return
      await stream.writeSSE({ id: String(++id), event: e.type, data: JSON.stringify(e) })
    }

    // 1. Snapshot of current ledger state.
    try {
      const client = getClient()
      for (const e of client.snapshotEvents(topics)) await send(e)
    } catch (e) {
      // Sidecar not connected yet; clients can reconnect.
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ message: 'sidecar not connected', detail: String(e) }),
      })
    }

    // 2. Live tail.
    const unsubscribe = eventBus.subscribe((e) => {
      void send(e)
    })

    // Periodic keep-alive comment so proxies don't close idle connection.
    const keepAlive = setInterval(() => {
      void stream.writeSSE({ event: 'ping', data: '{}' })
    }, 25_000)

    stream.onAbort(() => {
      unsubscribe()
      clearInterval(keepAlive)
    })

    // Hold the stream open. streamSSE resolves when the consumer aborts.
    await new Promise<void>(() => {})
  })
})

export { events }
