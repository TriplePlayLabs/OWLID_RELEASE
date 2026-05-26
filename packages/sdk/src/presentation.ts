/**
 * Presentation Protocol Types
 *
 * ISO 18013-5 style session bootstrap with an OpenID4VP 1.0 §6 DCQL
 * payload on the wire:
 *
 *   Holder shows ONE QR (`SessionEngagement`)
 *     ↓ verifier scans, WebSocket connect
 *   Verifier sends `PresentationRequest` carrying a DCQL query
 *     ↓ holder approves
 *   Holder sends `PresentationResponse` with a DCQL `vp_token` map
 *     (one SD-JWT VC presentation per DCQL credentials[].id, every
 *     KB-JWT bound to the same shared nonce + audience).
 */

import type { DcqlRequest } from '@owlid/verifier-client'

// ---------------------------------------------------------------------------
// Session Engagement (goes in the QR code)
// ---------------------------------------------------------------------------

/** Data encoded in the holder's QR code. The verifier scans this to
 *  establish a session.
 *
 *  Wire encoding is the compact `OWLP1:<wsUrl>` form by default (one
 *  short URL — no JSON, no duplicated sessionId, no inline nonce). The
 *  legacy `OWLP:<base64url(JSON)>` form is still parsed for old QRs
 *  that might still be in flight (decoded into the full shape below
 *  with `sessionId` / `nonce` populated). All new optional fields
 *  are reserved for future transports — none of them are required to
 *  start a session in the compact format.
 *
 *  The server pushes the session `nonce` over WS in the `session_ready`
 *  message payload, so the verifier doesn't need it in the QR — and
 *  the holder already has it locally from the create-session response.
 *  `sessionId` is the last path segment of `wsUrl`; never put it in
 *  the QR separately. */
export interface SessionEngagement {
  version: 1
  /** WebSocket transport info. `sessionId` is the URL's last path
   *  segment — kept as a derived convenience for legacy code paths
   *  that haven't migrated to `sessionIdFromWsUrl(ws.url)`. */
  ws: {
    url: string
    sessionId?: string
  }
  /** BLE transport info — reserved for an ISO 18013-5-style mDL
   *  in-person flow (verifier reads the phone over Bluetooth, no
   *  internet). Never populated by the current code paths. */
  ble?: {
    serviceUuid: string
    ephemeralPublicKey: string
  }
  /** Reserved for future ECDH session encryption. Currently unused. */
  holderEphemeralKey?: string
  /** Server-generated nonce. ONLY populated by the legacy decoder for
   *  back-compat with pre-OWLP1 QRs; on the compact path the verifier
   *  reads the nonce from the WS `session_ready` payload instead, so
   *  it doesn't need to be on the QR at all. */
  nonce?: string
}

// ---------------------------------------------------------------------------
// Presentation Request (verifier → holder)
// ---------------------------------------------------------------------------

/** What the verifier wants to verify. Sent over the back-channel after scanning. */
export interface PresentationRequest {
  sessionId: string
  /** Display name shown on the holder's consent screen */
  verifierName: string
  /** OpenID4VP 1.0 §6 DCQL query — the wire-level credential request. */
  dcql: DcqlRequest
  /** Server-generated nonce bound to this session */
  nonce: string
  /** Unix timestamp when the request was created */
  timestamp: number
  /** OpenID4VP `client_id` (typically the verifier's response_uri). Folded
   *  into the on-chain attestation key for `nationality_in` / `resident_in`
   *  predicates so two verifiers asking the same allowed-set produce
   *  distinct keys (anti-cross-verifier correlation). Required whenever
   *  the DCQL contains a `nationality_in` / `resident_in` claim — the
   *  holder app will refuse to attest those without it. */
  verifierId: string
}

// ---------------------------------------------------------------------------
// Presentation Response (holder → verifier)
// ---------------------------------------------------------------------------

/** The holder's proof, sent after biometric approval. */
export interface PresentationResponse {
  sessionId: string
  /** OpenID4VP 1.0 §8.1 vp_token — keyed by `dcql.credentials[].id`.
   *  The value is ALWAYS an array of one or more SD-JWT VC
   *  presentations (`<JWT>~<disc>~…~<KB-JWT>`), even when the
   *  credential query did not set `multiple`. Each KB-JWT signs
   *  over the shared session nonce + verifier audience. */
  vpToken: Record<string, string[]>
  /** UI receipts: which wallet credential answered which DCQL id +
   *  which claim names were disclosed. Local-only — the verifier
   *  already sees every disclosed value in `vpToken`. */
  used?: Array<{ dcqlId: string; credentialId: string; disclosures: string[] }>
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
   * Holder-only. Proof generation failed for any reason (wallet has no
   * matching credential, signing failed, transport, etc.). Payload is
   * intentionally opaque so a malicious holder cannot smuggle private
   * data through the verifier's UI.
   */
  | 'proof_failed'
  /**
   * Soft notice: the peer's WebSocket dropped (e.g. a phone whose
   * screen locked). The session survives until its TTL — the recipient
   * shows a transient "reconnecting…" status and keeps waiting for the
   * peer to rejoin, rather than treating it as a terminal error.
   */
  | 'peer_disconnected'
  /** Transport-level errors only — see `WsError`. */
  | 'error'

export interface WsMessage {
  type: WsMessageType
  payload: PresentationRequest | PresentationResponse | ProofFailedPayload | WsError | null
}

export interface ProofFailedPayload {
  /** Stable opaque code; never includes free-form holder-supplied text. */
  code: 'proof_failed'
}

export interface WsError {
  /** Transport / session-level errors only. */
  code: 'timeout' | 'denied' | 'invalid_session' | 'transport_error' | 'invalid_message'
  message: string
}

// ---------------------------------------------------------------------------
// QR Encoding / Decoding
// ---------------------------------------------------------------------------

const ENGAGEMENT_PREFIX_LEGACY = 'OWLP:'
const ENGAGEMENT_PREFIX_COMPACT = 'OWLP1:'

/** Encode a SessionEngagement as the compact `OWLP1:<wsUrl>` form.
 *  Everything else on the SessionEngagement type is either derivable
 *  from the URL (sessionId) or pushed over the WS handshake (nonce),
 *  so the QR shrinks from a ~400-char base64 JSON blob to a ~60-char
 *  URL string — many fewer QR modules at the same error-correction
 *  level. */
export function encodeSessionEngagement(engagement: SessionEngagement): string {
  return ENGAGEMENT_PREFIX_COMPACT + engagement.ws.url
}

/** Decode either the compact (`OWLP1:`) or the legacy
 *  base64-JSON (`OWLP:`) form. Compact returns `{version, ws: {url}}`;
 *  legacy returns the full historical shape so the verifier code path
 *  that reads `engagement.nonce` keeps working until every old QR has
 *  rolled out of users' sessions. */
export function decodeSessionEngagement(qrData: string): SessionEngagement | null {
  if (qrData.startsWith(ENGAGEMENT_PREFIX_COMPACT)) {
    const url = qrData.slice(ENGAGEMENT_PREFIX_COMPACT.length)
    if (!url) return null
    return {
      version: 1,
      ws: { url, sessionId: sessionIdFromWsUrl(url) },
    }
  }
  if (qrData.startsWith(ENGAGEMENT_PREFIX_LEGACY)) {
    try {
      const b64 = qrData
        .slice(ENGAGEMENT_PREFIX_LEGACY.length)
        .replace(/-/g, '+')
        .replace(/_/g, '/')
      const json = atob(b64)
      return JSON.parse(json) as SessionEngagement
    } catch {
      return null
    }
  }
  return null
}

/** Pull the chain session id out of a presentation WebSocket URL —
 *  it is the last path segment by construction
 *  (`/ws/presentation/<sessionId>` on relative URLs, or the same
 *  segment on absolute ones). Returns undefined when the URL has no
 *  trailing path component to use. */
export function sessionIdFromWsUrl(wsUrl: string): string | undefined {
  // Use a permissive base for relative URLs so the same parsing
  // logic handles `/ws/...` and `wss://host/ws/...` uniformly.
  let path: string
  try {
    path = new URL(wsUrl, 'wss://placeholder.invalid').pathname
  } catch {
    path = wsUrl
  }
  const last = path.split('/').filter(Boolean).pop()
  return last || undefined
}

/** Check if a QR string is a presentation engagement (compact or
 *  legacy JSON form), as opposed to a stand-alone SD-JWT VC. */
export function isPresentationEngagement(qrData: string): boolean {
  return qrData.startsWith(ENGAGEMENT_PREFIX_COMPACT) || qrData.startsWith(ENGAGEMENT_PREFIX_LEGACY)
}

/** Check if a string is an SD-JWT VC (issuance or presentation form). */
export function isSdJwtVc(value: string): boolean {
  return value.startsWith('eyJ') && value.includes('~')
}
