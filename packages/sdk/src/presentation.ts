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

export type WsMessageType = 'session_ready' | 'request' | 'response' | 'consent_denied' | 'error'

export interface WsMessage {
  type: WsMessageType
  payload: PresentationRequest | PresentationResponse | WsError | null
}

export interface WsError {
  code: 'timeout' | 'denied' | 'invalid_session' | 'transport_error' | 'invalid_message'
  message: string
}

// ---------------------------------------------------------------------------
// Available predicates (shared between holder consent screen and verifier selector)
// ---------------------------------------------------------------------------

export const PRESENTATION_PREDICATES: PresentationPredicate[] = [
  { id: 'isOver18', label: 'Age 18 or older' },
  { id: 'isOver21', label: 'Age 21 or older' },
  { id: 'isOver65', label: 'Age 65 or older' },
  { id: 'isEuCitizen', label: 'EU Citizenship' },
  { id: 'isResident', label: 'Residency' },
  { id: 'verificationLevel', label: 'Identity verification level' },
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
