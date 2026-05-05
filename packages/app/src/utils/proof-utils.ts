import { Calendar, BadgeCheck, MapPin, Globe, Shield } from 'lucide-react'
import type { VerifiedClaims, PredicateRequest } from '@owlid/sdk'
import type { PredicateInfo } from '@owlid/sdk/verifier'
import type { DerivedProof } from '~/types/proof'

/**
 * Per-predicate display metadata. The registry from `/predicates` carries the
 * canonical id, attribute, label, and wire shape. Icon + extended description
 * are pure UI concerns and live here so the registry stays free of frontend
 * coupling. Unknown ids fall back to a generic shield icon.
 */
const PREDICATE_DISPLAY: Record<
  string,
  {
    icon: DerivedProof['icon']
    description: string
    title?: string
  }
> = {
  'age:>=18': {
    icon: Calendar,
    title: 'Age check',
    description: 'Proves you are at least 18 without revealing your date of birth.',
  },
  'age:>=21': {
    icon: BadgeCheck,
    title: '21+ age check',
    description: 'Proves you are at least 21 without revealing your date of birth.',
  },
  'age:>=65': {
    icon: BadgeCheck,
    title: '65+ age check',
    description: 'Proves you are at least 65 without revealing your date of birth.',
  },
  'nationality:eu': {
    icon: Globe,
    title: 'EU citizenship',
    description: 'Proves EU citizenship without revealing your specific nationality.',
  },
  'residency:verified': {
    icon: MapPin,
    title: 'Residency',
    description: 'Proves you have a verified residency status.',
  },
  'kyc:>=basic': {
    icon: Shield,
    title: 'KYC: basic',
    description: 'Proves your identity has been verified at the basic level.',
  },
  'kyc:>=substantial': {
    icon: Shield,
    title: 'KYC: substantial',
    description: 'Proves your identity has been verified at the substantial level.',
  },
  'kyc:>=high': {
    icon: Shield,
    title: 'KYC: high',
    description: 'Proves your identity has been verified at the highest level.',
  },
}

function verificationLevelOrdinal(level: VerifiedClaims['verificationLevel'] | undefined): number {
  switch (level) {
    case 'basic':
      return 1
    case 'substantial':
      return 2
    case 'high':
      return 3
    default:
      return 0
  }
}

/**
 * Translate a registry predicate id to the boolean result reported on the
 * verified-claims sheet. Used purely for the green-checkmark UI; the actual
 * proof generation reads the registry's attribute/op/value.
 */
function predicateResultFromClaims(predicateId: string, claims: VerifiedClaims): boolean {
  switch (predicateId) {
    case 'age:>=18':
      return !!claims.isOver18
    case 'age:>=21':
      return !!claims.isOver21
    case 'age:>=65':
      return !!claims.isOver65
    case 'nationality:eu':
      return !!claims.isEuCitizen
    case 'residency:verified':
      return !!claims.isResident
    case 'kyc:>=basic':
      return verificationLevelOrdinal(claims.verificationLevel) >= 1
    case 'kyc:>=substantial':
      return verificationLevelOrdinal(claims.verificationLevel) >= 2
    case 'kyc:>=high':
      return verificationLevelOrdinal(claims.verificationLevel) >= 3
    default:
      return true
  }
}

/**
 * Filter the predicate registry to entries the holder can both prove (claim
 * present + result = true) and is permitted to prove (predicate id on the
 * credential's `availablePredicates` allowlist, when set).
 */
export function getAvailableProofs(
  claims: VerifiedClaims | null,
  registry: PredicateInfo[] | undefined,
  allowlist?: string[],
): DerivedProof[] {
  if (!claims || !registry) return []

  const allowed = (id: string) => !allowlist || allowlist.length === 0 || allowlist.includes(id)

  return registry
    .filter((p) => allowed(p.id))
    .map((p) => {
      const display = PREDICATE_DISPLAY[p.id] ?? {
        icon: Shield,
        description: p.label,
      }
      return {
        id: p.id,
        title: display.title ?? p.label,
        claim: p.label,
        result: predicateResultFromClaims(p.id, claims),
        icon: display.icon,
        sourceField: p.attribute,
        description: display.description,
      }
    })
}

/**
 * Build the wire-shape `PredicateRequest`s for a given predicate id by reading
 * the registry. Returns `[]` if the id is not in the registry.
 */
export function getProofPredicates(
  predicateId: string,
  registry: PredicateInfo[] | undefined,
): PredicateRequest[] {
  const pred = registry?.find((p) => p.id === predicateId)
  if (!pred) return []
  return [
    {
      attribute: pred.attribute,
      op: pred.op as PredicateRequest['op'],
      value: pred.value,
    },
  ]
}
