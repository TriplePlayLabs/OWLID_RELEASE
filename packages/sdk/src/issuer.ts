/**
 * OwlIssuer — ergonomic issuer-side client.
 *
 * Customer-facing API for any service that issues OwlID credentials. Wraps
 * the underlying HTTP details so callers work with plain function calls and
 * typed results.
 *
 *     import { OwlIssuer } from '@owlid/sdk'
 *
 *     const issuer = new OwlIssuer({ apiKey: process.env.OWLID_API_KEY })
 *
 *     const session = await issuer.startSession('didit')
 *     // run your KYC flow, then:
 *     const credential = await issuer.issue(session.id, {
 *       holderPublicKey: holderPk,
 *       algorithm: 'p256',
 *     })
 */
import {
  Configuration,
  CredentialsApi,
  InfoApi,
  PollingApi,
  ProvidersApi,
  SessionsApi,
} from '@owlid/issuer-client'
// Predicate + circuit-data registry now lives on the verification service
// (verifier-side concern). SDK consumers reach it via OwlVerifier.
import { apiKeyHeaders } from '@owlid/config'

const DEFAULT_BASE_URL = 'https://api.owlid.app'

export interface OwlIssuerOptions {
  /** Owl API key issued from your account dashboard. Required. */
  apiKey: string
  /** Override the base URL. Defaults to the hosted OwlID platform. */
  baseUrl?: string
}

/** Identity attributes for a verified user (per-provider keys). */
export type Claims = Record<string, unknown>

/** Owner key algorithm — `p256` for WebAuthn passkeys, `ed25519` for raw. */
export type HolderAlgorithm = 'p256' | 'ed25519'

/** Holder identity bound into an issued credential. */
export interface Holder {
  /** Hex public key. */
  publicKey: string
  /** Key algorithm. Defaults to `p256` (WebAuthn). */
  algorithm?: HolderAlgorithm
}

/** Snapshot of an issuance session. */
export interface IssuanceSession {
  id: string
  providerId: string
  /** Lifecycle state: `pending`, `verified`, `complete`, `expired`. */
  status: string
  /** Provider flow shape: `form_based`, `oidc_redirect`, `saml_redirect`, `webhook_async`, `qr_polling`. */
  flowType: string
  /** When the session expires (ISO timestamp). */
  expiresAt: string
  /** Flow-specific bootstrap payload (form fields, redirect URL, QR data, etc.). */
  start: SessionStart
}

/** Discriminated bootstrap payload returned with a new session. */
export type SessionStart =
  | { type: 'form'; fields: FormField[] }
  | { type: 'redirect'; url: string; relayState?: string }
  | { type: 'qr'; qrData: string; orderRef: string; autoStartUrl?: string }
  | { type: 'webhook'; url: string }

export interface FormField {
  name: string
  label: string
  type: string
  required: boolean
}

/** Verified identity claims for an issuance session. */
export interface IssuedClaims extends Record<string, unknown> {
  providerId: string
}

/** Issued credential — a standard SD-JWT VC (`application/dc+sd-jwt`). */
export interface IssuedCredential {
  /** SD-JWT VC string (issuance form). Hand to the holder wallet to store. */
  sdJwtVc: string
}

/** Public details about your issuer identity. */
export interface IssuerInfo {
  name: string
  publicKey: string
}

/** Available identity providers configured for your account. */
export interface ProviderInfo {
  id: string
  name: string
  flowType: string
}

export class OwlIssuer {
  readonly #sessions: SessionsApi
  readonly #credentials: CredentialsApi
  readonly #info: InfoApi
  readonly #providers: ProvidersApi
  readonly #polling: PollingApi

  constructor(options: OwlIssuerOptions) {
    if (!options?.apiKey) {
      throw new Error('OwlIssuer requires an apiKey. Get one from your Owl dashboard.')
    }
    const config = new Configuration({
      basePath: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
      headers: apiKeyHeaders(options.apiKey),
    })
    this.#sessions = new SessionsApi(config)
    this.#credentials = new CredentialsApi(config)
    this.#info = new InfoApi(config)
    this.#providers = new ProvidersApi(config)
    this.#polling = new PollingApi(config)
  }

  /** Public details about your issuer (name + signing public key). */
  async info(): Promise<IssuerInfo> {
    const r = await this.#info.getIssuerInfo()
    return { name: r.name, publicKey: r.publicKey }
  }

  /** List identity providers configured for your account. */
  async listProviders(): Promise<ProviderInfo[]> {
    const list = await this.#providers.listProviders()
    return list.map((p) => ({ id: p.id, name: p.name, flowType: p.flowType }))
  }

  /**
   * Start an issuance session for a given identity provider.
   *
   * The returned `start` payload is provider-specific — render the form,
   * follow the redirect, show the QR, etc.
   */
  async startSession(providerId: string): Promise<IssuanceSession> {
    const r = await this.#sessions.createSession({ createSessionRequest: { providerId } })
    return mapSession(r)
  }

  /** Read the current state of a session. */
  async getSession(sessionId: string): Promise<IssuanceSession> {
    const r = await this.#sessions.getSession({ id: sessionId })
    return mapSession(r as unknown as Parameters<typeof mapSession>[0])
  }

  /** Submit verified identity claims (form-based providers). */
  async submitClaims(sessionId: string, claims: Claims): Promise<void> {
    await this.#sessions.submitIdentity({
      id: sessionId,
      body: claims as Record<string, never>,
    })
  }

  /** Read verified claims once a session reaches `verified`. */
  async getClaims(sessionId: string): Promise<IssuedClaims> {
    return (await this.#sessions.getClaims({ id: sessionId })) as IssuedClaims
  }

  /**
   * Issue an SD-JWT VC bound to the holder's confirmation key.
   *
   * The session must be in `verified` state. The returned SD-JWT VC is
   * the holder's to store — Owl does not retain unhashed claim values
   * past the session TTL.
   */
  async issue(sessionId: string, holder: Holder): Promise<IssuedCredential> {
    const r = await this.#credentials.issueCredential({
      id: sessionId,
      issueCredentialRequest: {
        ownerPublicKey: holder.publicKey,
        keyAlgorithm: holder.algorithm ?? 'p256',
      },
    })
    if (!r.success) {
      throw new Error(r.error ?? 'Issuance failed')
    }
    return { sdJwtVc: r.credential as string }
  }

  /**
   * OpenID4VCI Batch Credential issuance for unlinkability — mint
   * `batchSize` one-time-use SD-JWT VCs (1..=64). Each carries a
   * distinct `credential_id` and is independently revocable on
   * Midnight; the holder presents each to at most one verifier so two
   * verifiers cannot correlate. The session must be in `verified`
   * state. Same holder `cnf` across the batch.
   */
  async issueBatch(
    sessionId: string,
    holder: Holder,
    batchSize: number,
  ): Promise<IssuedCredential[]> {
    const r = await this.#credentials.issueCredential({
      id: sessionId,
      issueCredentialRequest: {
        ownerPublicKey: holder.publicKey,
        keyAlgorithm: holder.algorithm ?? 'p256',
        batchSize,
      },
    })
    if (!r.success) {
      throw new Error(r.error ?? 'Issuance failed')
    }
    const list = r.credentials ?? [r.credential as string]
    return list.map((sdJwtVc) => ({ sdJwtVc }))
  }

  /** Poll a session until it terminates (verified, complete, expired). */
  async poll(sessionId: string): Promise<IssuanceSession> {
    const r = await this.#polling.pollSession({ sessionId })
    return mapSession(r as unknown as Parameters<typeof mapSession>[0])
  }
}

// Backwards-compatibility re-export of the generated issuer-client. Internal
// apps that hand-build hooks against the raw generated surface keep working;
// new public-facing apps should prefer `OwlIssuer` above.
export * from '@owlid/issuer-client'

interface RawSessionLike {
  sessionId?: string
  id?: string
  providerId: string
  flowType: string
  status: string
  expiresAt: string
  url?: string
  relayState?: string
  qrData?: string
  orderRef?: string
  autoStartUrl?: string
  config?: {
    fields?: Array<{
      name: string
      label: string
      fieldType?: string
      type?: string
      required: boolean
    }>
  }
  type?: string
}

function mapSession(r: RawSessionLike): IssuanceSession {
  return {
    id: r.sessionId ?? r.id ?? '',
    providerId: r.providerId,
    status: String(r.status),
    flowType: String(r.flowType),
    expiresAt: r.expiresAt,
    start: mapStart(r),
  }
}

function mapStart(r: RawSessionLike): SessionStart {
  switch (r.flowType) {
    case 'form_based':
      return {
        type: 'form',
        fields:
          r.config?.fields?.map((f) => ({
            name: f.name,
            label: f.label,
            type: f.fieldType ?? f.type ?? 'text',
            required: f.required,
          })) ?? [],
      }
    case 'oidc_redirect':
    case 'saml_redirect':
      return { type: 'redirect', url: r.url ?? '', relayState: r.relayState }
    case 'qr_polling':
      return {
        type: 'qr',
        qrData: r.qrData ?? '',
        orderRef: r.orderRef ?? '',
        autoStartUrl: r.autoStartUrl,
      }
    case 'webhook_async':
      return { type: 'webhook', url: r.url ?? '' }
    default:
      return { type: 'redirect', url: r.url ?? '' }
  }
}
