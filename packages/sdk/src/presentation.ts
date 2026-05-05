/**
 * Presentation Protocol Types
 *
 * Implements ISO 18013-5 style credential presentation:
 * - Holder shows ONE QR code (SessionEngagement)
 * - Verifier scans it, connects via WebSocket or BLE
 * - Verifier sends PresentationRequest (what they need)
 * - Holder shows consent screen, approves with biometric
 * - Holder sends PresentationResponse (ZK proof) over back-channel
 *
 * Two transports: WebSocket (universal) and BLE (Chrome/Edge, offline proximity)
 */

// ---------------------------------------------------------------------------
// Session Engagement (goes in the QR code)
// ---------------------------------------------------------------------------

/** Data encoded in the holder's QR code. The verifier scans this to establish a session. */
export interface SessionEngagement {
  version: 1
  /** WebSocket transport info */
  ws?: {
    url: string
    sessionId: string
  }
  /** BLE transport info (optional, Chrome/Edge only) */
  ble?: {
    serviceUuid: string
    ephemeralPublicKey: string
  }
  /** Holder's ephemeral public key for ECDH session encryption */
  holderEphemeralKey: string
  /** Server-generated nonce bound to this session (used by verifier to build request) */
  nonce: string
}

// ---------------------------------------------------------------------------
// Presentation Request (verifier → holder)
// ---------------------------------------------------------------------------

/** What the verifier wants to verify. Sent over the back-channel after scanning. */
export interface PresentationRequest {
  sessionId: string
  /** Display name shown on the holder's consent screen */
  verifierName: string
  /** ZK predicates the verifier wants proven (age >= 21, EU citizen, etc.) */
  requestedPredicates: PresentationPredicate[]
  /** Attribute names to disclose in cleartext (usually empty for ZK flows) */
  requestedDisclosures: string[]
  /** Server-generated nonce bound to this session */
  nonce: string
  /** Unix timestamp when the request was created */
  timestamp: number
}

/** A single predicate the verifier wants proven */
export interface PresentationPredicate {
  /** Predicate ID matching the proof system (isOver18, isOver21, isEuCitizen, etc.) */
  id: string
  /** Human-readable label for the consent screen */
  label: string
}

// ---------------------------------------------------------------------------
// Presentation Response (holder → verifier)
// ---------------------------------------------------------------------------

/** The holder's proof, sent after biometric approval. */
export interface PresentationResponse {
  sessionId: string
  /** Compact token (OID1:...) containing the ZK proof bound to the session nonce */
  compactToken: string
}

// ---------------------------------------------------------------------------
// WebSocket Message Envelope
// ---------------------------------------------------------------------------

export type WsMessageType =
  | 'session_ready'
  | 'request'
  | 'response'
  | 'consent_denied'
  /**
   * Holder-only. The holder evaluated the predicate against their credential
   * and the value does NOT satisfy it (e.g. age below threshold). This is a
   * normal terminal outcome of the protocol, NOT an error: the verifier
   * surfaces it as `valid: false`. Payload carries only the attribute name
   * the verifier already asked about — never any value derived from the
   * holder's credential.
   */
  | 'predicate_not_satisfied'
  /**
   * Holder-only. Proof generation failed for a reason other than the holder
   * not meeting the predicate (proving system / serialization / unexpected).
   * Payload is intentionally opaque so a malicious holder cannot smuggle
   * private data through the verifier's UI.
   */
  | 'proof_failed'
  /** Transport-level errors only — see `WsError`. */
  | 'error'

export interface WsMessage {
  type: WsMessageType
  payload:
    | PresentationRequest
    | PresentationResponse
    | PredicateNotSatisfiedPayload
    | ProofFailedPayload
    | WsError
    | null
}

export interface PredicateNotSatisfiedPayload {
  /** Credential field the failing predicate targeted (e.g. `dateOfBirth`). */
  attribute: string
  /** Optional registry id for the predicate (e.g. `age:>=21`). */
  predicateId?: string
}

export interface ProofFailedPayload {
  /** Stable opaque code; never includes free-form holder-supplied text. */
  code: 'proof_failed'
}

export interface WsError {
  /** Transport / session-level errors only. Predicate outcomes use their
   * own message types above so verifiers don't render them as errors. */
  code: 'timeout' | 'denied' | 'invalid_session' | 'transport_error' | 'invalid_message'
  message: string
}

// ---------------------------------------------------------------------------
// Available predicates (shared between holder consent screen and verifier selector)
// ---------------------------------------------------------------------------

/**
 * Static fallback list of predicates. Apps SHOULD fetch the live list from
 * `GET /predicates` on the issuer service (see `@owlid/issuer-client`'s
 * `InfoApi.listPredicates`) so the UI tracks the registry as new predicates
 * land. This constant exists for offline tools and tests; ids match the
 * canonical predicate registry exposed by the issuer service.
 */
export const PRESENTATION_PREDICATES: PresentationPredicate[] = [
  { id: 'age:>=18', label: 'Age 18 or older' },
  { id: 'age:>=21', label: 'Age 21 or older' },
  { id: 'age:>=65', label: 'Age 65 or older' },
  { id: 'nationality:eu', label: 'EU citizenship' },
  { id: 'residency:verified', label: 'Verified resident' },
  { id: 'kyc:>=basic', label: 'KYC level: basic or higher' },
  { id: 'kyc:>=substantial', label: 'KYC level: substantial or higher' },
  { id: 'kyc:>=high', label: 'KYC level: high' },
]

// ---------------------------------------------------------------------------
// QR Encoding / Decoding
// ---------------------------------------------------------------------------

const ENGAGEMENT_PREFIX = 'OWLP:'

/** Encode a SessionEngagement into a QR-safe string */
export function encodeSessionEngagement(engagement: SessionEngagement): string {
  const json = JSON.stringify(engagement)
  // Base64url encode (no padding)
  const b64 = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return ENGAGEMENT_PREFIX + b64
}

/** Decode a QR string back into a SessionEngagement */
export function decodeSessionEngagement(qrData: string): SessionEngagement | null {
  if (!qrData.startsWith(ENGAGEMENT_PREFIX)) return null
  try {
    const b64 = qrData.slice(ENGAGEMENT_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(b64)
    return JSON.parse(json) as SessionEngagement
  } catch {
    return null
  }
}

/** Check if a QR string is a presentation engagement (vs a compact token) */
export function isPresentationEngagement(qrData: string): boolean {
  return qrData.startsWith(ENGAGEMENT_PREFIX)
}

/** Check if a QR string is a compact token */
export function isCompactToken(qrData: string): boolean {
  return qrData.startsWith('OID1:')
}
