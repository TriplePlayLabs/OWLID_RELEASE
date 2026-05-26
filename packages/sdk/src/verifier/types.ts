/**
 * Public types for the verifier-side client. Kept in their own module
 * so `OwlVerifier.ts` reads as method bodies, not a wall of interfaces.
 */
import type { DcqlRequest } from '@owlid/verifier-client'

export interface OwlVerifierOptions {
  /** Owl API key issued from your account dashboard. Required. */
  apiKey: string
  /** Override the base URL. Defaults to the hosted OwlID platform. */
  baseUrl?: string
}

/** Result of a token verification. */
export interface VerificationResult {
  valid: boolean
  /** Disclosed attributes the holder revealed in the token. Only present if `valid`. */
  subjects?: Record<string, unknown>
  /** Failure reason: untrusted issuer, expired, revoked, challenge mismatch, etc. */
  error?: string
}

/** Single-use challenge minted by Owl. */
export interface Challenge {
  challenge: string
  expiresIn: number
}

/** Trusted issuer entry visible to your account. */
export interface IssuerInfo {
  publicKey: string
  name: string
  description?: string
  isActive: boolean
}

/** Notification pushed when a credential's revocation status changes. */
export interface RevocationEvent {
  credentialId: string
  status: 'revoked' | 'suspended' | 'reactivated'
  reason?: string
}

/**
 * A predicate the system can prove. `op` + `value` are the wire shape
 * the holder puts on a `PredicateRequest` — `value` is JSON-encoded.
 */
export interface Predicate {
  /** Canonical id, e.g. `age:>=18` or `nationality:eu`. */
  id: string
  /** Credential attribute this predicate reads from. */
  attribute: string
  /** Human-readable label. */
  label: string
  /** Operator. */
  op: 'GreaterOrEqual' | 'InSet'
  /**
   * JSON-encoded wire value. For `GreaterOrEqual`, a number (e.g. `'18'`).
   * For `InSet`, a registered dataset name (e.g. `'"eu"'`).
   */
  value: string
}

/** Summary entry for a registered set-membership circuit dataset. */
export interface CircuitDatasetSummary {
  name: string
  version: number
}

/** Full contents of a set-membership circuit dataset. */
export interface CircuitDatasetContents {
  name: string
  version: number
  items: string[]
}

/** Active presentation session (verifier side of the QR flow). */
export interface PresentationSession {
  /** Opaque session id. */
  sessionId: string
  /** WebSocket path the holder QR encodes. */
  wsUrl: string
  /** Single-use nonce bound into the holder's token. */
  nonce: string
  /** Seconds until this session expires. */
  expiresIn: number
  /** Fully resolved WebSocket URL for the verifier role. */
  verifierWsUrl: string
  /** Payload to encode into the QR shown to the holder. */
  qrPayload: string
}

/** Options for `OwlVerifier.requestPresentation`. */
export interface PresentationRequestOptions {
  /** Display name shown on the holder's consent screen. */
  verifierName: string
  /** OpenID4VP `client_id` — the verifier's stable identity (typically the
   *  response_uri or a deployment URL). Folded into the on-chain
   *  attestation key for `nationality_in` / `resident_in` predicates so
   *  two verifiers asking for the same allowed-set produce distinct
   *  keys. Must match what the verifier passes to `verifyDcql` (and what
   *  the holder app sends to the sidecar for nationality / residency
   *  attestations). */
  verifierId: string
  /** OpenID4VP 1.0 §6 DCQL query — the only credential request shape. */
  dcql: DcqlRequest
  /** Callback to render the QR payload for the holder. */
  onQr?: (qrPayload: string) => void
  /** Abort after this many milliseconds. Defaults to 90 s. */
  timeoutMs?: number
}
