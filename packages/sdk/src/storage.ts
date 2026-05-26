/**
 * Wallet storage — list of SD-JWT VC credentials, one per IdP.
 *
 * Layout (localStorage keys):
 *   owl_wallet_index        JSON `string[]` of credentialIds (oldest first)
 *   owl_wallet_cred:<id>    serialized {@link WalletCredential}
 *   owl_wallet_key:<id>     PRF-wrapped Ed25519/P-256 holder seed (per cred)
 *   owl_webauthn_credential  the wallet-global passkey (unlock gate)
 *
 * Holder keys are per-credential — every issuance mints a fresh `cnf`
 * key so batch siblings and per-IdP credentials stay independently
 * unlinkable on the wire. The single passkey unlocks each per-cred key
 * via PRF derivation.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * WebAuthn passkey — the wallet-global unlock gate. One per wallet.
 * Private key never leaves the secure enclave; only the credentialId +
 * COSE public key are stored. The PRF extension on this credential
 * derives the symmetric key that wraps every per-credential seed.
 */
export interface StoredWebAuthnCredential {
  credentialId: string
  publicKey: string
  counter: number
  transports: string[]
}

/**
 * Disclosed claims as the holder received them at issuance (unhashed).
 * Optional fields are present only when the provider actually vouches
 * for them — Google won't carry `birthDate`, Didit won't carry `hd`.
 */
export interface VerifiedClaims {
  firstName?: string
  lastName?: string
  dateOfBirth?: string
  placeOfBirth?: string
  nationality?: string
  gender?: string
  nationalId?: string
  passportNumber?: string
  driversLicense?: string
  taxId?: string

  documentType?: string
  documentNumber?: string
  issuingCountry?: string
  documentExpiry?: string
  documentIssueDate?: string

  /** Portrait from a document scan. Local display only; never disclosed. */
  portraitImage?: string

  /**
   * Holder-only unique-personhood witness (32-byte hex), issuer-derived
   * for document-verified / government-eID identities. Stored locally so
   * the witness-on-device orchestrator can prove `attestUniquePersonhood`
   * — it is NEVER an SD-JWT disclosure and never reaches a verifier.
   */
  personhoodSecret?: string

  streetAddress?: string
  city?: string
  postalCode?: string
  country?: string

  isOver18?: boolean
  isOver21?: boolean
  isOver65?: boolean
  isEuCitizen?: boolean
  isResident?: boolean

  /** OIDC account claims (Google / Apple / Microsoft / generic). */
  email?: string
  emailVerified?: boolean
  name?: string
  pictureUrl?: string
  locale?: string
  /** Google Workspace organisation domain (`hd` claim). */
  hostedDomain?: string
  /** Apple private email relay indicator. */
  isPrivateEmail?: boolean
  /** Provider-stable subject (Google `sub`, Apple `sub`, Microsoft `oid`). */
  subject?: string

  verificationLevel?: string
  verifiedAt?: string
  verifiedBy?: string
  verificationMethod?: string
}

/**
 * Per-IdP card rendering shape. The kind drives which React component
 * the wallet's UI picks; the payload carries provider-specific extras
 * the component needs that don't fit in {@link VerifiedClaims}.
 */
export type CardShape =
  | { kind: 'passport'; portraitImage?: string }
  | { kind: 'google-account'; hostedDomain?: string }
  | { kind: 'apple-id'; relayEmail?: boolean }
  | { kind: 'generic-oidc'; brandName: string; logoUrl?: string }

/**
 * One credential in the wallet. Replaces the legacy single-cred
 * `Credential + StoredCredentialData` pair.
 */
export interface WalletCredential {
  /** Stable id (base64url(sha-256(issuer JWT))) — also the on-chain handle. */
  credentialId: string
  /** SD-JWT VC string in issuance form (`<JWT>~<disc>~…~`). */
  sdJwtVc: string
  /** Issuer `iss` claim (did:web URL). */
  issuer: string
  /** Provider that drove the IdP flow (`didit`, `google`, …). */
  providerId: string
  /** ISO timestamp of issuance. */
  issuedAt: string
  /** ISO timestamp from the SD-JWT VC `exp` claim, when present. */
  expiresAt?: string
  /** Rendering shape for the per-IdP UI card. */
  cardShape: CardShape
  /** Disclosed claims as received at issuance (local-only). */
  verifiedClaims: VerifiedClaims
  /** Per-credential `cnf` public key (hex). The wrapped seed lives under
   *  the `owl_wallet_key:<credentialId>` storage key. */
  holderPublicKeyHex: string
  /** Other batch-sibling credentialIds when issued via OID4VCI Batch.
   *  Empty / undefined for non-batch credentials. */
  batchSiblings?: string[]
}

// ============================================================================
// Storage keys
// ============================================================================

export const STORAGE_KEYS = {
  WALLET_INDEX: 'owl_wallet_index',
  WALLET_CRED_PREFIX: 'owl_wallet_cred:',
  WALLET_KEY_PREFIX: 'owl_wallet_key:',
  WEBAUTHN_CREDENTIAL: 'owl_webauthn_credential',
  USERNAME: 'owl_username',
} as const

// ============================================================================
// Storage adapter
// ============================================================================

export interface StorageAdapter {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined'
}

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
// Card-shape inference
// ============================================================================

/** Map a provider id + disclosed claims to a {@link CardShape}.  */
export function buildCardShape(providerId: string, claims: VerifiedClaims): CardShape {
  const id = providerId.toLowerCase()
  if (id === 'didit' || id.startsWith('mock-')) {
    return { kind: 'passport', portraitImage: claims.portraitImage }
  }
  if (id === 'google') {
    return { kind: 'google-account', hostedDomain: claims.hostedDomain }
  }
  if (id === 'apple') {
    return { kind: 'apple-id', relayEmail: claims.isPrivateEmail }
  }
  return { kind: 'generic-oidc', brandName: providerId }
}

// ============================================================================
// Storage manager
// ============================================================================

export class CredentialStorageManager {
  constructor(private storage: StorageAdapter = browserStorageAdapter) {}

  // WebAuthn passkey — wallet-global unlock gate.

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

  // Username — wallet display label (not a credential).

  async saveUsername(username: string): Promise<void> {
    await this.storage.setItem(STORAGE_KEYS.USERNAME, username)
  }

  async loadUsername(): Promise<string | null> {
    return await this.storage.getItem(STORAGE_KEYS.USERNAME)
  }

  // Wallet credential list.

  /** Append a credential + its PRF-wrapped seed to the wallet. */
  async addCredential(credential: WalletCredential, wrappedKey: string): Promise<void> {
    const ids = await this.readIndex()
    if (!ids.includes(credential.credentialId)) {
      ids.push(credential.credentialId)
    }
    await Promise.all([
      this.storage.setItem(
        STORAGE_KEYS.WALLET_CRED_PREFIX + credential.credentialId,
        JSON.stringify(credential),
      ),
      this.storage.setItem(STORAGE_KEYS.WALLET_KEY_PREFIX + credential.credentialId, wrappedKey),
      this.storage.setItem(STORAGE_KEYS.WALLET_INDEX, JSON.stringify(ids)),
    ])
  }

  /** All credentials in insertion order. */
  async listCredentials(): Promise<WalletCredential[]> {
    const ids = await this.readIndex()
    const creds = await Promise.all(ids.map((id) => this.getCredential(id)))
    return creds.filter((c): c is WalletCredential => c !== null)
  }

  async getCredential(credentialId: string): Promise<WalletCredential | null> {
    const json = await this.storage.getItem(STORAGE_KEYS.WALLET_CRED_PREFIX + credentialId)
    if (!json) return null
    try {
      return JSON.parse(json) as WalletCredential
    } catch {
      return null
    }
  }

  async removeCredential(credentialId: string): Promise<void> {
    const ids = (await this.readIndex()).filter((id) => id !== credentialId)
    await Promise.all([
      this.storage.removeItem(STORAGE_KEYS.WALLET_CRED_PREFIX + credentialId),
      this.storage.removeItem(STORAGE_KEYS.WALLET_KEY_PREFIX + credentialId),
      this.storage.setItem(STORAGE_KEYS.WALLET_INDEX, JSON.stringify(ids)),
    ])
  }

  /** True iff the wallet contains at least one credential with both
   *  its serialized blob AND its wrapped key on disk. */
  async hasAnyCredential(): Promise<boolean> {
    const ids = await this.readIndex()
    for (const id of ids) {
      const [cred, key] = await Promise.all([
        this.storage.getItem(STORAGE_KEYS.WALLET_CRED_PREFIX + id),
        this.storage.getItem(STORAGE_KEYS.WALLET_KEY_PREFIX + id),
      ])
      if (cred && key) return true
    }
    return false
  }

  async getCredentialKeyWrapped(credentialId: string): Promise<string | null> {
    return await this.storage.getItem(STORAGE_KEYS.WALLET_KEY_PREFIX + credentialId)
  }

  /** Wipe every wallet key — including the passkey gate and username. */
  async clearAll(): Promise<void> {
    const ids = await this.readIndex()
    const perCred = ids.flatMap((id) => [
      STORAGE_KEYS.WALLET_CRED_PREFIX + id,
      STORAGE_KEYS.WALLET_KEY_PREFIX + id,
    ])
    await Promise.all(
      [
        STORAGE_KEYS.WALLET_INDEX,
        STORAGE_KEYS.WEBAUTHN_CREDENTIAL,
        STORAGE_KEYS.USERNAME,
        ...perCred,
      ].map((k) => this.storage.removeItem(k)),
    )
  }

  private async readIndex(): Promise<string[]> {
    const json = await this.storage.getItem(STORAGE_KEYS.WALLET_INDEX)
    if (!json) return []
    try {
      const parsed = JSON.parse(json)
      return Array.isArray(parsed) ? (parsed.filter((s) => typeof s === 'string') as string[]) : []
    } catch {
      return []
    }
  }
}

/** Default storage manager using browser localStorage. */
export const storage = new CredentialStorageManager()
