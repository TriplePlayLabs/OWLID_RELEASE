/**
 * OwlID API Service Layer
 *
 * Provides typed API calls to the OwlID backend services:
 * - Issuer Service (port 8001) - identity verification and credential issuance
 * - Verification Service (port 8000) - token verification
 */

const ISSUER_URL = import.meta.env.VITE_ISSUER_URL || 'http://localhost:8001'
const VERIFICATION_URL = import.meta.env.VITE_VERIFICATION_URL || 'http://localhost:8000'

// Warn if non-localhost URLs are not using HTTPS
function warnIfInsecure(url: string, label: string) {
  try {
    const parsed = new URL(url)
    if (
      parsed.protocol === 'http:' &&
      parsed.hostname !== 'localhost' &&
      parsed.hostname !== '127.0.0.1'
    ) {
      console.warn(
        `[OwlID] ${label} is using HTTP (${url}). Use HTTPS for non-localhost deployments.`,
      )
    }
  } catch {
    // ignore invalid URLs - will fail at fetch time
  }
}
warnIfInsecure(ISSUER_URL, 'ISSUER_URL')
warnIfInsecure(VERIFICATION_URL, 'VERIFICATION_URL')

// ============================================================================
// Types
// ============================================================================

export type ProviderFlowType = 'saml_redirect' | 'qr_polling' | 'webhook_async' | 'form_based'

export type SessionStatus = 'pending' | 'verifying' | 'verified' | 'failed' | 'expired'

export type FlowState =
  | { type: 'saml_pending'; relayState: string }
  | { type: 'saml_processing'; relayState: string }
  | { type: 'polling_pending' }
  | { type: 'polling'; orderRef: string; pollCount: number; lastPoll: string }
  | { type: 'webhook_pending'; externalSessionId?: string }
  | { type: 'webhook_waiting'; externalSessionId: string }
  | { type: 'form_pending' }
  | { type: 'form_processing' }
  | { type: 'completed' }
  | { type: 'failed'; reason: string }

export interface ProviderInfo {
  id: string
  name: string
  description: string
  verificationLevels: string[]
  country: string
  flowType: ProviderFlowType
  verificationLevel: string
}

export interface FormField {
  name: string
  label: string
  fieldType: 'text' | 'date' | 'select' | 'number'
  required: boolean
  placeholder?: string
  validationPattern?: string
}

export interface FormConfig {
  fields: FormField[]
  instructions?: string
}

export type VerificationStart =
  | { type: 'Redirect'; url: string; relayState?: string }
  | { type: 'QrCode'; qrData: string; orderRef: string; autoStartUrl?: string }
  | { type: 'HostedUi'; url: string; externalSessionId: string }
  | { type: 'Form'; config: FormConfig }

export interface CreateSessionResponse {
  sessionId: string
  providerId: string
  flowType: ProviderFlowType
  status: SessionStatus
  expiresAt: string
  type: VerificationStart['type']
  url?: string
  relayState?: string
  qrData?: string
  orderRef?: string
  autoStartUrl?: string
  externalSessionId?: string
  config?: FormConfig
}

export interface Session {
  id: string
  providerId: string
  flowType: ProviderFlowType
  status: SessionStatus
  flowState: FlowState
  expiresAt: string
  isExpired: boolean
  verifiedAt?: string
  credentialIssued: boolean
}

export interface IdentityForm {
  firstName: string
  lastName: string
  dateOfBirth: string
  placeOfBirth: string
  nationality: string
  nationalId: string
  streetAddress: string
  city: string
  postalCode: string
  country: string
  gender?: string
  passportNumber?: string
  driversLicense?: string
  taxId?: string
}

import type { VerifiedClaims, StoredCredential as Credential } from '@owlid/sdk'

/** Warning from verification provider indicating why manual review is needed */
export interface VerificationWarning {
  code: string
  shortDescription: string
  longDescription?: string
  risk?: string
}

/** Response from complete verification endpoint */
export interface CompleteVerificationResult {
  status: 'verified' | 'pending'
  claims?: VerifiedClaims
  message?: string
  /** Provider-specific status (e.g., "In Review", "Pending") */
  providerStatus?: string
  /** Warnings/reasons for manual review */
  warnings?: VerificationWarning[]
  /** Suggested retry delay in seconds (for exponential backoff) */
  retryAfterSecs?: number
}

export interface VerificationResult {
  valid: boolean
  error?: string
  subjects?: Record<string, unknown>
}

export interface KeyPairResponse {
  publicKey: string
  privateKey: string
}

export interface IssueCredentialResponse {
  success: boolean
  credential: Credential
  error?: string
}

// ============================================================================
// API Client
// ============================================================================

class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  })

  if (!response.ok) {
    const errorText = await response.text()
    let errorMessage: string
    try {
      const errorJson = JSON.parse(errorText)
      errorMessage = errorJson.error || errorJson.message || errorText
    } catch (parseErr) {
      // Response body is not JSON - use raw text or status code
      if (errorText) {
        errorMessage = errorText
      } else {
        errorMessage = `HTTP ${response.status} ${response.statusText || ''}`.trim()
      }
    }
    throw new ApiError(errorMessage, response.status)
  }

  return response.json()
}

// ============================================================================
// Issuer Service API (port 8001)
// ============================================================================

export const issuerApi = {
  async health(): Promise<string> {
    const response = await fetch(`${ISSUER_URL}/health`)
    return response.text()
  },

  async listProviders(): Promise<ProviderInfo[]> {
    return fetchJson(`${ISSUER_URL}/providers`)
  },

  async createSession(providerId: string): Promise<CreateSessionResponse> {
    return fetchJson(`${ISSUER_URL}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ providerId }),
    })
  },

  async getSession(sessionId: string): Promise<Session> {
    return fetchJson(`${ISSUER_URL}/sessions/${sessionId}`)
  },

  async pollSession(sessionId: string): Promise<{
    status: SessionStatus
    message: string
    hint?: string
  }> {
    return fetchJson(`${ISSUER_URL}/internal/poll/${sessionId}`)
  },

  async submitIdentity(sessionId: string, form: IdentityForm): Promise<VerifiedClaims> {
    return fetchJson(`${ISSUER_URL}/sessions/${sessionId}/submit`, {
      method: 'POST',
      body: JSON.stringify(form),
    })
  },

  async autoVerify(sessionId: string): Promise<VerifiedClaims> {
    return fetchJson(`${ISSUER_URL}/sessions/${sessionId}/auto-verify`, {
      method: 'POST',
    })
  },

  async getClaims(sessionId: string): Promise<VerifiedClaims> {
    return fetchJson(`${ISSUER_URL}/sessions/${sessionId}/claims`)
  },

  /**
   * Complete verification for webhook_async providers (like Didit)
   * Polls the external provider's decision endpoint and returns claims when ready
   */
  async completeVerification(sessionId: string): Promise<CompleteVerificationResult> {
    return fetchJson(`${ISSUER_URL}/sessions/${sessionId}/complete`, {
      method: 'POST',
    })
  },

  async issueCredential(
    sessionId: string,
    ownerPublicKey: string,
    keyAlgorithm: 'p256' | 'ed25519' = 'p256',
  ): Promise<IssueCredentialResponse> {
    return fetchJson(`${ISSUER_URL}/sessions/${sessionId}/issue`, {
      method: 'POST',
      body: JSON.stringify({
        ownerPublicKey,
        keyAlgorithm,
      }),
    })
  },

  async generateKeypair(): Promise<KeyPairResponse> {
    return fetchJson(`${ISSUER_URL}/keypair`, { method: 'POST' })
  },

  async getIssuerInfo(): Promise<{ publicKey: string; name: string }> {
    return fetchJson(`${ISSUER_URL}/issuer-info`)
  },
}

// ============================================================================
// Verification Service API (port 8000)
// ============================================================================

export const verificationApi = {
  async health(): Promise<string> {
    const response = await fetch(`${VERIFICATION_URL}/health`)
    return response.text()
  },

  async verifyToken(token: unknown, challenge: string): Promise<VerificationResult> {
    return fetchJson(`${VERIFICATION_URL}/verify`, {
      method: 'POST',
      body: JSON.stringify({ token, challenge }),
    })
  },

  async listTrustedIssuers(): Promise<
    Array<{
      publicKey: string
      name: string
      description?: string
      isActive: boolean
    }>
  > {
    return fetchJson(`${VERIFICATION_URL}/issuers`)
  },

  async addTrustedIssuer(
    publicKey: string,
    name: string,
    description?: string,
  ): Promise<{ success: boolean; message: string }> {
    return fetchJson(`${VERIFICATION_URL}/issuers`, {
      method: 'POST',
      body: JSON.stringify({ publicKey, name, description }),
    })
  },

  async checkRevocation(credentialId: string): Promise<{
    credentialId: string
    status: string
  }> {
    return fetchJson(`${VERIFICATION_URL}/revocation/check`, {
      method: 'POST',
      body: JSON.stringify({ credentialId }),
    })
  },
}

// ============================================================================
// Combined API
// ============================================================================

export const owlApi = {
  issuer: issuerApi,
  verification: verificationApi,
}

export default owlApi
