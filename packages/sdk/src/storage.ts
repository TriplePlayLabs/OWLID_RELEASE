/**
 * Storage Types and Utilities
 *
 * Platform-agnostic storage with adapter pattern.
 * Works with localStorage, AsyncStorage, or any custom backend.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * WebAuthn credential stored locally
 * Private key never leaves the secure enclave - only credential ID and public key are stored
 */
export interface StoredWebAuthnCredential {
  /** Base64url-encoded credential ID */
  credentialId: string
  /** Base64-encoded COSE public key */
  publicKey: string
  /** Signature counter for replay protection */
  counter: number
  /** Supported transports (e.g., 'internal', 'hybrid') */
  transports: string[]
}

/**
 * Proof document issued by the credential issuer
 */
export interface Credential {
  rootHash: string
  tree: unknown
  issuerSignature: string
  issuerPublicKey: string
  ownerPublicKey: string
  issuedAt: string
  attributes?: Record<string, unknown>
  /** Allow additional properties from different issuers */
  [key: string]: unknown
}

/**
 * Verified claims from identity provider
 */
export interface VerifiedClaims {
  firstName: string
  lastName: string
  dateOfBirth: string
  placeOfBirth: string
  nationality: string
  gender?: string
  nationalId: string
  passportNumber?: string
  driversLicense?: string
  taxId?: string

  // Document information (from document-based verification like Didit, Onfido, Jumio)
  /** Type of document used for verification (Passport, ID Card, Driver's License) */
  documentType?: string
  /** Document number (generic - may be passport, ID, or driver's license) */
  documentNumber?: string
  /** Country that issued the document (ISO 3166-1 alpha-2) */
  issuingCountry?: string
  /** Document expiration date (YYYY-MM-DD) */
  documentExpiry?: string
  /** Document issue date (YYYY-MM-DD) */
  documentIssueDate?: string

  // Biometric data (for local display only, NOT in credential)
  /** Portrait image from document/selfie (base64) - stored locally for passport display */
  portraitImage?: string

  streetAddress: string
  city: string
  postalCode: string
  country: string
  isOver18: boolean
  isOver21: boolean
  isOver65: boolean
  isEuCitizen: boolean
  isResident: boolean
  verificationLevel: string
  verifiedAt: string
  verifiedBy: string
  verificationMethod: string
}

/**
 * Complete credential data stored locally
 * Uses WebAuthn for secure signing - private key stays in secure enclave
 */
export interface StoredCredentialData {
  credential: Credential
  /** P-256 owner public key (hex) - used in credential */
  ownerPublicKey: string
  /** WebAuthn credential ID for signing */
  webauthnCredentialId: string
  issuerPublicKey: string
  verifiedClaims: VerifiedClaims
  sessionId: string
  issuedAt: string
}

/**
 * Identity data for passport display
 */
export interface IdentityData {
  firstName: string
  lastName: string
  birthDate: string
  birthPlace: string
  nationality: string
  nationalId: string
  passportNumber: string
  taxId: string
  creditScore: number
  accountNumber: string
  email: string
  phone: string
  address: string
  occupation: string
  employer: string
  maritalStatus: string
  /** Portrait image from verification (base64) - for passport photo display */
  portraitImage?: string
}

// ============================================================================
// Storage Keys
// ============================================================================

export const STORAGE_KEYS = {
  ENCRYPTED_IDENTITY: 'owl_encrypted_identity',
  CREDENTIAL_ID: 'owl_credential_id',
  USERNAME: 'owl_username',
  PROOF_CREDENTIAL: 'owl_proof_credential',
  OWNER_PUBLIC_KEY: 'owl_owner_public_key',
  WEBAUTHN_CREDENTIAL: 'owl_webauthn_credential',
  ISSUER_PUBLIC_KEY: 'owl_issuer_public_key',
  VERIFIED_CLAIMS: 'owl_verified_claims',
  IDP_SESSION_ID: 'owl_idp_session_id',
} as const

// ============================================================================
// Storage Adapter Interface
// ============================================================================

/**
 * Platform-agnostic storage interface
 * Implement this for different environments (browser localStorage, React Native AsyncStorage, etc.)
 */
export interface StorageAdapter {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}

/**
 * Check if running in browser with localStorage available
 */
function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined'
}

/**
 * Browser localStorage adapter
 */
export const browserStorageAdapter: StorageAdapter = {
  getItem: (key) => (isBrowser() ? localStorage.getItem(key) : null),
  setItem: (key, value) => {
    if (isBrowser()) localStorage.setItem(key, value)
  },
  removeItem: (key) => {
    if (isBrowser()) localStorage.removeItem(key)
  },
}

// ============================================================================
// Storage Manager
// ============================================================================

/**
 * Credential and identity storage manager
 * Works with any storage backend via adapter pattern
 */
export class CredentialStorageManager {
  constructor(private storage: StorageAdapter = browserStorageAdapter) {}

  // WebAuthn Credential

  async saveWebAuthnCredential(cred: StoredWebAuthnCredential): Promise<void> {
    await this.storage.setItem(STORAGE_KEYS.WEBAUTHN_CREDENTIAL, JSON.stringify(cred))
  }

  async loadWebAuthnCredential(): Promise<StoredWebAuthnCredential | null> {
    const json = await this.storage.getItem(STORAGE_KEYS.WEBAUTHN_CREDENTIAL)
    if (!json) return null
    try {
      return JSON.parse(json) as StoredWebAuthnCredential
    } catch {
      return null
    }
  }

  async hasWebAuthnCredential(): Promise<boolean> {
    return !!(await this.storage.getItem(STORAGE_KEYS.WEBAUTHN_CREDENTIAL))
  }

  // Credential Data

  async saveCredentialData(data: StoredCredentialData): Promise<void> {
    await Promise.all([
      this.storage.setItem(STORAGE_KEYS.PROOF_CREDENTIAL, JSON.stringify(data.credential)),
      this.storage.setItem(STORAGE_KEYS.OWNER_PUBLIC_KEY, data.ownerPublicKey || ''),
      this.storage.setItem(STORAGE_KEYS.ISSUER_PUBLIC_KEY, data.issuerPublicKey || ''),
      this.storage.setItem(STORAGE_KEYS.VERIFIED_CLAIMS, JSON.stringify(data.verifiedClaims)),
      this.storage.setItem(STORAGE_KEYS.IDP_SESSION_ID, data.sessionId),
    ])
  }

  async loadCredentialData(): Promise<StoredCredentialData | null> {
    const [credentialJson, ownerPublicKey, webauthnJson, issuerPublicKey, claimsJson, sessionId] =
      await Promise.all([
        this.storage.getItem(STORAGE_KEYS.PROOF_CREDENTIAL),
        this.storage.getItem(STORAGE_KEYS.OWNER_PUBLIC_KEY),
        this.storage.getItem(STORAGE_KEYS.WEBAUTHN_CREDENTIAL),
        this.storage.getItem(STORAGE_KEYS.ISSUER_PUBLIC_KEY),
        this.storage.getItem(STORAGE_KEYS.VERIFIED_CLAIMS),
        this.storage.getItem(STORAGE_KEYS.IDP_SESSION_ID),
      ])

    if (!credentialJson) return null

    const webauthnCred = webauthnJson
      ? (JSON.parse(webauthnJson) as StoredWebAuthnCredential)
      : null

    // WebAuthn credential is required - no more legacy keypair fallback
    if (!webauthnCred) return null

    try {
      return {
        credential: JSON.parse(credentialJson) as Credential,
        ownerPublicKey: ownerPublicKey || '',
        webauthnCredentialId: webauthnCred.credentialId,
        issuerPublicKey: issuerPublicKey || '',
        verifiedClaims: claimsJson
          ? (JSON.parse(claimsJson) as VerifiedClaims)
          : ({} as VerifiedClaims),
        sessionId: sessionId || '',
        issuedAt: new Date().toISOString(),
      }
    } catch {
      return null
    }
  }

  async hasStoredCredential(): Promise<boolean> {
    const [credentialVal, webauthnVal] = await Promise.all([
      this.storage.getItem(STORAGE_KEYS.PROOF_CREDENTIAL),
      this.storage.getItem(STORAGE_KEYS.WEBAUTHN_CREDENTIAL),
    ])
    return !!credentialVal && !!webauthnVal
  }

  async getStoredCredential(): Promise<Credential | null> {
    const json = await this.storage.getItem(STORAGE_KEYS.PROOF_CREDENTIAL)
    if (!json) return null
    try {
      return JSON.parse(json) as Credential
    } catch {
      return null
    }
  }

  async getOwnerPublicKey(): Promise<string | null> {
    return await this.storage.getItem(STORAGE_KEYS.OWNER_PUBLIC_KEY)
  }

  async getStoredClaims(): Promise<VerifiedClaims | null> {
    const json = await this.storage.getItem(STORAGE_KEYS.VERIFIED_CLAIMS)
    if (!json) return null
    try {
      return JSON.parse(json) as VerifiedClaims
    } catch {
      return null
    }
  }

  // Identity

  async saveIdentity(credentialId: string, username: string): Promise<void> {
    await Promise.all([
      this.storage.setItem(STORAGE_KEYS.CREDENTIAL_ID, credentialId),
      this.storage.setItem(STORAGE_KEYS.USERNAME, username),
    ])
  }

  async saveEncryptedIdentity(identityData: IdentityData): Promise<void> {
    const encryptedBlob = btoa(JSON.stringify(identityData))
    await this.storage.setItem(STORAGE_KEYS.ENCRYPTED_IDENTITY, encryptedBlob)
  }

  async loadStoredIdentity(): Promise<{
    encryptedBlob: string | null
    credentialId: string | null
    username: string | null
  }> {
    const [encryptedBlob, credentialId, username] = await Promise.all([
      this.storage.getItem(STORAGE_KEYS.ENCRYPTED_IDENTITY),
      this.storage.getItem(STORAGE_KEYS.CREDENTIAL_ID),
      this.storage.getItem(STORAGE_KEYS.USERNAME),
    ])
    return { encryptedBlob, credentialId, username }
  }

  async hasStoredIdentity(): Promise<boolean> {
    const { encryptedBlob, credentialId, username } = await this.loadStoredIdentity()
    return !!(encryptedBlob && credentialId && username)
  }

  decryptIdentity(encryptedBlob: string): IdentityData {
    return JSON.parse(atob(encryptedBlob))
  }

  // Clear

  async clearAll(): Promise<void> {
    await Promise.all(Object.values(STORAGE_KEYS).map((key) => this.storage.removeItem(key)))
  }
}

/** Default storage manager instance using browser localStorage */
export const storage = new CredentialStorageManager()
