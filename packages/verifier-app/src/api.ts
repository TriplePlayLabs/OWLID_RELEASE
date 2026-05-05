const VERIFICATION_URL = import.meta.env.VITE_VERIFICATION_URL || 'http://localhost:8000'
const API_KEY = import.meta.env.VITE_API_KEY || 'dev_key_12345678901234567890123456789012'

const headers = {
  'Content-Type': 'application/json',
  'X-API-Key': API_KEY,
}

export interface VerifyResult {
  valid: boolean
  error?: string
  subjects?: Record<string, unknown>
}

export interface ChallengeResponse {
  challenge: string
  expiresIn: number
}

/** Request a server-generated challenge. Must be done before verification. */
export async function getChallenge(): Promise<ChallengeResponse> {
  const resp = await fetch(`${VERIFICATION_URL}/verify/challenge`, { headers })
  if (!resp.ok) throw new Error(`Failed to get challenge: ${resp.status}`)
  return resp.json()
}

/** Verify a token against a server-generated challenge. */
export async function verifyToken(token: string, challenge: string): Promise<VerifyResult> {
  const resp = await fetch(`${VERIFICATION_URL}/verify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ token, challenge }),
  })

  if (!resp.ok && resp.status !== 200) {
    const text = await resp.text()
    try {
      const json = JSON.parse(text)
      return { valid: false, error: json.error || `HTTP ${resp.status}` }
    } catch {
      return { valid: false, error: text || `HTTP ${resp.status}` }
    }
  }

  return resp.json()
}

export async function healthCheck(): Promise<boolean> {
  try {
    const resp = await fetch(`${VERIFICATION_URL}/health`)
    return resp.ok
  } catch {
    return false
  }
}
