/**
 * In-process event bus for chain-state changes.
 *
 * The sidecar subscribes to each contract's `contractStateObservable`
 * and computes diffs between successive ledger snapshots. Diffs are
 * pushed onto this bus as typed events. The /events SSE endpoint
 * fans out to every connected client. Backpressure is handled by
 * dropping events for slow consumers (best-effort delivery).
 */

export type RevocationEvent = {
  type: 'revocation'
  rootHash: string // hex (64 chars)
  status: 'REVOKED' | 'SUSPENDED' | 'ACTIVE'
  issuerKeyHash: string // hex (64 chars)
  reason: string | null
  ts: number // ms epoch
}

export type IssuerEvent = {
  type: 'issuer'
  publicKeyHash: string // hex (64 chars)
  status: 'INACTIVE' | 'ACTIVE' | 'DEACTIVATED'
  publicKey: string // hex (64 chars)
  name: string
  ts: number
}

export type IdentityEvent = {
  type: 'identity'
  didHash: string // hex (64 chars)
  commitment: string // hex (64 chars)
  status: 'INACTIVE' | 'ACTIVE' | 'EXPIRED'
  issuerKeyHash: string // hex (64 chars)
  ts: number
}

export type AttestationEvent = {
  type: 'attestation'
  attestKey: string // hex (64 chars) — persistentHash(tag‖rootHash‖param)
  ts: number
}

/** Lifecycle of a /predicates/{kind}/relay job. Emitted by
 *  `MidnightClient.runRelayJob` at each phase transition; the long-poll
 *  status endpoint awaits the next event for a given `jobId` instead of
 *  rapid-firing fixed-interval HTTP requests. */
export type RelayJobEvent = {
  type: 'relay'
  jobId: string // hex (64 chars)
  phase: 'queued' | 'balancing' | 'submitting' | 'submitted' | 'balance-failed' | 'submit-failed'
  /** Chain transaction id once `submitTx` has returned. */
  txId?: string
  /** Error captured if the background driver failed. */
  error?: string
  ts: number
}

export type SidecarEvent =
  | RevocationEvent
  | IssuerEvent
  | IdentityEvent
  | AttestationEvent
  | RelayJobEvent

type Listener = (event: SidecarEvent) => void

class EventBus {
  private listeners = new Set<Listener>()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: SidecarEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (e) {
        console.warn('[events] listener threw:', e)
      }
    }
  }

  size(): number {
    return this.listeners.size
  }
}

export const eventBus = new EventBus()
