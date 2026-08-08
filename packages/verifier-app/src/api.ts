import {
  getIssuersApi,
  getMonitoringApi,
  getRegistryApi,
  getRevocationsApi,
  getVerificationApi,
  type ChallengeResponse,
  type CheckRevocationResponse,
  type DcqlRequest,
  type PredicateInfo,
  type RevocationEntry,
  type TrustedIssuerInfo,
  type VerifyResponse,
} from '@owlid/verifier-client'
import { getApiKey } from '@owlid/sdk'

/**
 * Single-credential verification result — a flattened view of the
 * 1-entry DCQL response the verifier-app sends. Multi-credential
 * verifiers should use {@link OwlVerifier.verifyDcql} directly.
 */
export type VerifyResult = VerifyResponse
export type { ChallengeResponse, PredicateInfo }

export function getVerifierApiKey(): string {
  // Verifier ships in the browser, so it MUST use a publishable (`pk_`)
  // key — secret keys grant manage-* permissions and would leak. The
  // app-shared `VITE_API_KEY` is usually the operator `sk_` key (issuer
  // session calls need it); allow an override via `VITE_VERIFIER_API_KEY`
  // so the verifier can be configured independently.
  const overrideKey =
    typeof import.meta !== 'undefined' &&
    (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_VERIFIER_API_KEY
  const apiKey = overrideKey || getApiKey()
  if (!apiKey) {
    throw new Error('Verifier API key is not configured.')
  }
  if (!apiKey.startsWith('owlid_pk_')) {
    throw new Error(
      'Verifier app must be configured with a publishable API key (set VITE_VERIFIER_API_KEY).',
    )
  }
  return apiKey
}

export type { DcqlRequest }

/**
 * Verify a DCQL `vp_token` map (multi-credential). Flattens the
 * per-credential response into a single-display `VerifyResult`: when
 * every entry validates we merge the disclosed claims keyed by DCQL
 * id; when any fails the result captures the first error.
 */
export async function verifyDcqlVpToken(
  vpToken: Record<string, string[]>,
  challenge: string,
  /** The exact DCQL request sent to the holder. The server re-checks
   *  every credential query's `owl_predicate` extension against the
   *  Midnight attestation set — drop it and the predicate / personhood
   *  checks are never enforced. */
  query?: DcqlRequest,
  /** OID4VP verifier `client_id` — required for nationality_in /
   *  resident_in claims. Must match the value the holder used when
   *  attesting; mismatched → the recomputed on-chain key won't match. */
  verifierId?: string,
): Promise<VerifyResult> {
  try {
    const ids = Object.keys(vpToken)
    const r = await getVerificationApi({ apiKey: getVerifierApiKey() }).verifyDcql({
      verifyDcqlRequest: {
        vpToken,
        challenge,
        verifierId,
        query: query ?? {
          credentials: ids.map((id) => ({ id, format: 'dc+sd-jwt', claims: [] })),
        },
      },
    })
    const firstFailure = ids.map((id) => r.perCredential[id]).find((per) => per && !per.valid)
    return {
      valid: r.valid,
      subjects: r.subjects as Record<string, unknown> | undefined,
      // Per-credential errors first: the set-level error is the generic
      // "credential X not satisfied" which hides the actual reason
      // (signature, revocation, missing attestation, …).
      error: firstFailure?.error ?? r.error ?? undefined,
    }
  } catch (err) {
    const response = err && typeof err === 'object' && 'response' in err ? err.response : null
    if (!(response instanceof Response)) {
      throw err
    }
    const text = await response.text()
    try {
      const json = JSON.parse(text)
      return { valid: false, error: json.error || `HTTP ${response.status}` }
    } catch {
      return { valid: false, error: text || `HTTP ${response.status}` }
    }
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    await getMonitoringApi({ apiKey: getVerifierApiKey() }).health()
    return true
  } catch {
    return false
  }
}

/** List every predicate the system can prove. Public, no auth required. */
export async function listPredicates(): Promise<PredicateInfo[]> {
  return getRegistryApi({ apiKey: getVerifierApiKey() }).listPredicates()
}

/** Check whether a credential is revoked on Midnight. The verifier can
 *  pass any credential id format the backend accepts (b64url or hex
 *  sha-256 over the issuer JWT); the SDK exposes it as
 *  `SdJwtVc.credentialId()` / `credentialIdHex()`. */
export async function checkRevocation(credentialId: string): Promise<CheckRevocationResponse> {
  return getRevocationsApi({ apiKey: getVerifierApiKey() }).checkRevocation({
    checkRevocationRequest: { credentialId },
  })
}

/** List every revoked credential the verifier knows about (cached
 *  projection of the on-chain `revocation_registry`). */
export async function listRevoked(): Promise<RevocationEntry[]> {
  return getRevocationsApi({ apiKey: getVerifierApiKey() }).listRevoked()
}

/** List the trusted issuers — every issuer key the verifier accepts. */
export async function listTrustedIssuers(): Promise<TrustedIssuerInfo[]> {
  return getIssuersApi({ apiKey: getVerifierApiKey() }).listTrustedIssuers()
}

export type { TrustedIssuerInfo, RevocationEntry, CheckRevocationResponse }
