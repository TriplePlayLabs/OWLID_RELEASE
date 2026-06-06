/**
 * Human-readable labels for the verification checks the verifier asked
 * for. The verifier-app sanitizes registry predicate ids into DCQL ids
 * (`age:>=18` → `age___18`, `email:verified` → `email_verified`); this
 * maps them back to plain language for the result screen.
 */
const FRIENDLY: Record<string, string> = {
  age_gte: 'Age check',
  age_range: 'Age range',
  nationality_in: 'Nationality',
  nationality_eu: 'EU citizen',
  resident_in: 'Country of residence',
  residency_verified: 'Verified resident',
  email_verified: 'Verified email',
  kyc___basic: 'ID check: basic',
  kyc___substantial: 'ID check: substantial',
  kyc___high: 'ID check: high',
  verification_level: 'ID verification level',
  unique_person: 'Unique person',
}

function tidy(raw: string): string {
  return raw
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[a-z]/, (c) => c.toUpperCase())
}

/** Plain-language label for a sanitized DCQL credential-query id. */
export function friendlyCheckLabel(dcqlId: string): string {
  return FRIENDLY[dcqlId] ?? tidy(dcqlId)
}
