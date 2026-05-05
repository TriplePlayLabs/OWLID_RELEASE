import { apiKeyHeaders, getApiKey, getVerificationUrl } from '@owlid/sdk'

const VERIFICATION_URL = getVerificationUrl()
const API_KEY = getApiKey()
if (!API_KEY) {
  console.warn(
    "[verifier-app] No API key configured. Call `configure({ apiKey: '...' })` from @owlid/sdk at app startup, or set VITE_API_KEY at build time. Verification calls will be rejected.",
  )
}

// Verification service authenticates with `Authorization: Bearer <key>`,
// not `X-API-Key`. Routing the auth header through `apiKeyHeaders` keeps
// the verifier-app aligned with the rest of the SDK clients and avoids
// a CORS preflight reject (the backend's CORS allow-list only carries
// the canonical headers — content-type, authorization, accept, x-correlation-id).
const headers: Record<string, string> = {
  'Content-Type': 'application/json',
  ...apiKeyHeaders(API_KEY),
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

export interface PredicateInfo {
  id: string
  attribute: string
  label: string
  op: 'GreaterOrEqual' | 'InSet'
  value: string
}

/** List every predicate the system can prove. Public, no auth required. */
export async function listPredicates(): Promise<PredicateInfo[]> {
  const resp = await fetch(`${VERIFICATION_URL}/predicates`)
  if (!resp.ok) throw new Error(`Failed to fetch predicates: ${resp.status}`)
  return resp.json()
}
