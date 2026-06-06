/**
 * Map an opaque presentation-flow error string into something a human
 * can act on. Patterns match what the SDK orchestrator, the
 * verification service, and the Compact circuits actually throw — the
 * raw strings are server/jargon, the friendly copy here is what the
 * holder sees in the modal.
 *
 * Privacy contract (mirrors @owlid/sdk/proofs/errors): we never echo
 * witness data back to the UI. The patterns below only carry the
 * predicate / claim name the verifier already requested.
 */

import { parseProofError } from '@owlid/sdk'

export interface FriendlyPresentationError {
  /** Short title for the modal header. */
  title: string
  /** One- or two-sentence explanation in user language. */
  body: string
  /** Optional next-step hint shown under the body. */
  hint?: string
  /** Whether a Retry button can plausibly help. False means the
   *  problem is structural (missing credential, wrong country, …) and
   *  the user has to fix something else first. */
  retryable: boolean
  /** Raw upstream message — kept for the collapsible "Details" so
   *  bug reports stay actionable without forcing the user to read it. */
  raw: string
}

/** Categorise + reword a thrown error. Always returns a friendly
 *  payload — falls back to a generic message rather than throwing. */
export function formatPresentationError(err: unknown): FriendlyPresentationError {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error')

  // Structured native SDK errors first — those carry an opaque code.
  const proof = parseProofError(err)
  if (proof) {
    switch (proof.code) {
      case 'PREDICATE_NOT_SATISFIED':
        return {
          title: 'Your ID doesn’t answer this check',
          body: proof.attribute
            ? `The verifier asked about “${friendlyAttribute(proof.attribute)}” and your credential doesn’t carry that fact.`
            : 'The verifier asked for a check your credential isn’t stamped for.',
          hint: 'Use a different credential, or get one that covers this check.',
          retryable: false,
          raw,
        }
      case 'MISSING_ATTRIBUTE':
        return {
          title: 'Missing information',
          body: proof.attribute
            ? `Your credential is missing the “${friendlyAttribute(proof.attribute)}” field the verifier asked for.`
            : 'Your credential is missing a field the verifier asked for.',
          hint: 'Re-issue your credential after updating that information.',
          retryable: false,
          raw,
        }
      case 'TOKEN_EXPIRED':
        return {
          title: 'Credential expired',
          body: 'Your credential is past its expiry date.',
          hint: 'Re-verify with the issuer to get a fresh one.',
          retryable: false,
          raw,
        }
      case 'CHALLENGE_MISMATCH':
        return {
          title: 'Session out of sync',
          body: 'The verifier’s challenge changed before we could respond.',
          hint: 'Ask the verifier to show a fresh QR.',
          retryable: true,
          raw,
        }
      case 'CREDENTIAL_REVOKED':
        return {
          title: 'Credential revoked',
          body: 'Your credential was revoked by the issuer.',
          hint: 'You can’t use it anymore — request a new one.',
          retryable: false,
          raw,
        }
      case 'UNTRUSTED_ISSUER':
        return {
          title: 'Issuer not accepted',
          body: 'The verifier doesn’t trust the issuer of this credential.',
          hint: 'Use a credential from an issuer the verifier accepts.',
          retryable: false,
          raw,
        }
      case 'PROOF_FAILED':
      case 'TOKEN_NOT_ACTIVE':
      default:
        return {
          title: 'Proof rejected',
          body: 'The verifier rejected the proof we sent.',
          retryable: true,
          raw,
        }
    }
  }

  // String-pattern matches against unstructured server / orchestrator errors.
  const lower = raw.toLowerCase()

  // Server-side DCQL miss: "DCQL credential <name> unsatisfied"
  const dcqlMiss = raw.match(/DCQL credential ([^\s]+) unsatisfied/i)
  if (dcqlMiss) {
    const claim = friendlyClaimId(dcqlMiss[1]!)
    return {
      title: 'Missing credential',
      body: `Your wallet doesn’t have a credential that answers “${claim}”.`,
      hint: 'Add or verify the missing credential, then try again.',
      retryable: false,
      raw,
    }
  }

  // Compact circuit asserts surfaced from the prover.
  if (lower.includes('not in allowed set') || lower.includes('not in approved set')) {
    return {
      title: 'Country doesn’t match',
      body: 'The country on your credential isn’t in the list the verifier accepts.',
      hint: 'This verifier only accepts specific countries — yours isn’t one of them.',
      retryable: false,
      raw,
    }
  }
  if (lower.includes('not a verified resident')) {
    return {
      title: 'Residency not verified',
      body: 'Your credential isn’t stamped as a verified resident.',
      hint: 'Re-verify with a provider that confirms your address.',
      retryable: false,
      raw,
    }
  }
  if (lower.includes('no residence country in credential') || lower.includes('no nationality')) {
    return {
      title: 'Missing country information',
      body: 'Your credential doesn’t carry a country code — we can’t prove residency or nationality without it.',
      hint: 'Re-issue your credential from a provider that returns your country.',
      retryable: false,
      raw,
    }
  }
  if (lower.includes('age below') || lower.includes('age above')) {
    return {
      title: 'Age check failed',
      body: 'Your age doesn’t match what the verifier requires.',
      retryable: false,
      raw,
    }
  }
  if (lower.includes('kyc below')) {
    return {
      title: 'KYC level too low',
      body: 'The verifier wants a higher KYC level than your credential carries.',
      hint: 'Re-verify at a higher assurance level (substantial or high).',
      retryable: false,
      raw,
    }
  }

  // Relay / chain failures.
  if (lower.includes('on-chain attestation') && lower.includes('failed')) {
    return {
      title: 'Couldn’t record proof on-chain',
      body: 'The Midnight network rejected the proof. This is usually temporary.',
      hint: 'Wait a few seconds and try again.',
      retryable: true,
      raw,
    }
  }
  if (lower.includes('midnight sidecar') || lower.includes('sidecar unreachable')) {
    return {
      title: 'Service temporarily unavailable',
      body: 'The Midnight bridge isn’t responding right now.',
      hint: 'Try again in a moment.',
      retryable: true,
      raw,
    }
  }

  // Passkey / unlock failures.
  if (
    lower.includes('passkey') ||
    lower.includes('webauthn') ||
    lower.includes('user verification')
  ) {
    return {
      title: 'Couldn’t unlock your wallet',
      body: 'Your passkey didn’t complete the unlock step.',
      hint: 'Try again — make sure you complete the device prompt.',
      retryable: true,
      raw,
    }
  }
  if (lower.includes('missing holder key')) {
    return {
      title: 'Wallet key missing',
      body: 'We couldn’t find the signing key for this credential.',
      hint: 'Sign in with the passkey that originally saved this credential, or re-add the credential.',
      retryable: false,
      raw,
    }
  }

  // WebSocket / network drops.
  if (
    lower.includes('websocket') ||
    lower.includes('network') ||
    lower.includes('econnreset') ||
    lower.includes('connection')
  ) {
    return {
      title: 'Connection issue',
      body: 'We lost the connection to the verifier mid-flow.',
      hint: 'Check your network and try again.',
      retryable: true,
      raw,
    }
  }

  // DCQL request unsatisfied (wallet-side check before send).
  if (lower.includes('dcql request unsatisfied')) {
    return {
      title: 'Wallet can’t fulfil this request',
      body: 'Your wallet doesn’t have all the credentials the verifier asked for.',
      hint: 'Check the consent screen for the specific missing item.',
      retryable: false,
      raw,
    }
  }

  // Default fallback — friendly preamble + the raw message tucked into hint.
  return {
    title: 'Couldn’t share your ID',
    body: 'Something went wrong on the way to the verifier.',
    hint: raw.length < 240 ? raw : `${raw.slice(0, 230)}…`,
    retryable: true,
    raw,
  }
}

/** Convert a snake_case DCQL claim id into something readable. */
function friendlyClaimId(id: string): string {
  return id
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[a-z]/, (c) => c.toUpperCase())
}

/** Friendly label for a credential attribute the SDK names by its
 *  JSON key (e.g. `dateOfBirth` → `Date of birth`). */
function friendlyAttribute(attr: string): string {
  switch (attr) {
    case 'dateOfBirth':
      return 'date of birth'
    case 'nationality':
      return 'nationality'
    case 'residentCountry':
      return 'country of residence'
    case 'isResident':
      return 'resident status'
    case 'emailVerified':
      return 'email verification'
    case 'verificationLevel':
      return 'KYC level'
    case 'personhoodSecret':
      return 'unique-person token'
    default:
      return attr
        .replace(/([A-Z])/g, ' $1')
        .toLowerCase()
        .trim()
  }
}
