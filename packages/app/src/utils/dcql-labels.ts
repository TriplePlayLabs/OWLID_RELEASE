import type { DcqlRequest, PresentationRequest } from '@owlid/sdk'

/** Customer-facing label for a single DCQL claim path. Mirrors
 *  `predicate-routing.ts` in the SDK; the keys here are the standard
 *  claim paths verifiers send. */
const FRIENDLY_PATH: Record<string, string> = {
  age_over_18: 'Over 18',
  age_over_21: 'Over 21',
  age_over_65: 'Over 65',
  nationality_in: 'Nationality',
  nationality_eu: 'EU citizen',
  resident_in: 'Country of residence',
  resident: 'Resident',
  email_verified: 'Verified email',
  verification_level: 'Identity verification level',
  unique_person: 'Unique person',
  // Older proprietary attribute names — kept so legacy creds still read OK.
  isOver18: 'Over 18',
  isOver21: 'Over 21',
  isOver65: 'Over 65',
  isEuCitizen: 'EU citizen',
  isResident: 'Resident',
  emailVerified: 'Verified email',
}

/** Customer-facing label for a sanitized DCQL id. The verifier
 *  generates these from its internal predicate id, e.g.
 *  `email:verified` → `email_verified`, `age:>=18` → `age___18`. */
const FRIENDLY_DCQL_ID: Record<string, string> = {
  email_verified: 'Verified email',
  age___18: 'Over 18',
  age___21: 'Over 21',
  age___65: 'Over 65',
  nationality_in: 'Nationality',
  nationality_eu: 'EU citizen',
  resident_in: 'Country of residence',
  residency_verified: 'Resident',
  verification_level: 'Identity verification level',
  unique_personhood: 'Unique person',
}

/**
 * Translate a DCQL claim path (`["email_verified"]`) into something a
 * user can read. Falls back to a tidy capitalisation of the raw path
 * when nothing matches so a verifier asking for a custom claim isn't
 * shown as a bare `verification_level`.
 */
export function friendlyDcqlPath(path: ReadonlyArray<string>): string {
  const first = path[0]
  if (!first) return ''
  return FRIENDLY_PATH[first] ?? tidy(first)
}

/**
 * Pick the right label for a DCQL credential query the consent screen
 * is displaying. Prefers the claim path (richer signal — e.g. the
 * exact age threshold), falls back to the sanitized id, then to a
 * tidied string.
 */
export function friendlyDcqlLabel(dcqlId: string, request: PresentationRequest): string {
  const dcql = request.dcql as DcqlRequest | undefined
  const query = dcql?.credentials?.find((c) => c.id === dcqlId)
  const path = query?.claims?.[0]?.path
  if (Array.isArray(path) && path.length > 0) {
    const labelled = friendlyDcqlPath(path)
    if (labelled) return labelled
  }
  return FRIENDLY_DCQL_ID[dcqlId] ?? tidy(dcqlId)
}

function tidy(raw: string): string {
  return raw
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[a-z]/, (c) => c.toUpperCase())
}
