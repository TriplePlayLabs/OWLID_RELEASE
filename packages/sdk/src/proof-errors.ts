/**
 * Typed error decoding for proof / predicate operations crossing the native
 * SDK FFI.
 *
 * The native SDK encodes structured errors as `OWLERR:<json>` so we never
 * relay a Rust-side message string (which could carry witness data) through
 * the JS layer. Use `parseProofError(err)` at every catch site that wraps a
 * call into `Credential.prepare`, `Credential.prove`, etc.
 *
 * Privacy contract: the only fields that ever appear here are an opaque code
 * and — for `PREDICATE_NOT_SATISFIED` — the credential attribute name the
 * verifier already asked about. Never carry the witness value, the threshold,
 * the credential subject, or any other plaintext.
 */

const OWL_ERR_PREFIX = 'OWLERR:'

export type ProofErrorCode =
  | 'PREDICATE_NOT_SATISFIED'
  | 'MISSING_ATTRIBUTE'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_NOT_ACTIVE'
  | 'CHALLENGE_MISMATCH'
  | 'CREDENTIAL_REVOKED'
  | 'UNTRUSTED_ISSUER'
  | 'PROOF_FAILED'

export interface ProofError {
  code: ProofErrorCode
  /** Set for PREDICATE_NOT_SATISFIED and MISSING_ATTRIBUTE. */
  attribute?: string
  /** Set for PREDICATE_NOT_SATISFIED when the registry id is known. */
  predicateId?: string
}

/**
 * Decode a thrown error into a `ProofError` if it originated from the native
 * SDK. Returns `null` for any unrelated error so the caller can fall back to
 * generic handling.
 */
export function parseProofError(err: unknown): ProofError | null {
  if (!(err instanceof Error)) return null
  const msg = err.message
  if (!msg.startsWith(OWL_ERR_PREFIX)) return null
  try {
    const json = JSON.parse(msg.slice(OWL_ERR_PREFIX.length)) as {
      code?: string
      attribute?: string
      predicateId?: string
    }
    if (!json.code) return null
    return {
      code: json.code as ProofErrorCode,
      attribute: json.attribute,
      predicateId: json.predicateId ?? undefined,
    }
  } catch {
    return null
  }
}

/** Convenience: did the holder fail to satisfy the requested predicate? */
export function isPredicateNotSatisfied(err: unknown): boolean {
  return parseProofError(err)?.code === 'PREDICATE_NOT_SATISFIED'
}
