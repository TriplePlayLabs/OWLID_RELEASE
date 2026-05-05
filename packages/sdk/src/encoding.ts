/**
 * Encoding utilities for base64 and base64url
 */

/**
 * Convert ArrayBuffer to standard base64 string
 */
export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Convert standard base64 string to ArrayBuffer
 */
export function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

/**
 * Convert ArrayBuffer to base64url string (URL-safe, no padding)
 */
export function bufferToBase64url(buffer: ArrayBuffer): string {
  return bufferToBase64(buffer).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Convert base64url string to ArrayBuffer
 */
export function base64urlToBuffer(base64url: string): ArrayBuffer {
  // Convert base64url to standard base64
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  return base64ToBuffer(base64)
}

/**
 * Convert Uint8Array to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Convert hex string to Uint8Array
 */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16)
  }
  return bytes
}
