/**
 * Verifier-side QR engagement encoder. Browser-safe (no `Buffer`)
 * — uses the same `bufferToBase64url` helper the SDK already ships.
 */
import { bufferToBase64url } from '../encoding.js'

/**
 * Encode the holder QR payload — JSON-serialised engagement,
 * base64url-encoded for transport across QR libraries that don't
 * tolerate `=` padding.
 */
export function encodeQrPayload(engagement: {
  sessionId: string
  wsUrl: string
  nonce: string
}): string {
  const bytes = new TextEncoder().encode(JSON.stringify(engagement))
  return bufferToBase64url(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  )
}
