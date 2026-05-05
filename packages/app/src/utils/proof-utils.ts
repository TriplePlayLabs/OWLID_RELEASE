import { Calendar, BadgeCheck, MapPin, Globe, Shield } from 'lucide-react'
import type { VerifiedClaims, PredicateRequest } from '@owlid/sdk'
import type { DerivedProof } from '~/types/proof'

// EU member state ISO codes
const EU_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]

/**
 * Get available proofs from verified claims
 *
 * All values come directly from the backend - no frontend computation.
 * The backend is the single source of truth for derived attributes.
 */
export function getAvailableProofs(claims: VerifiedClaims | null): DerivedProof[] {
  if (!claims) return []

  return [
    {
      id: 'isOver18',
      title: 'Age check',
      claim: 'Over 18',
      result: claims.isOver18,
      icon: Calendar,
      sourceField: 'dateOfBirth',
      description: 'Proves you are at least 18 without revealing your date of birth.',
    },
    {
      id: 'isOver21',
      title: '21+ age check',
      claim: 'Over 21',
      result: claims.isOver21,
      icon: BadgeCheck,
      sourceField: 'dateOfBirth',
      description: 'Proves you are at least 21 without revealing your date of birth.',
    },
    {
      id: 'isOver65',
      title: '65+ age check',
      claim: 'Over 65',
      result: claims.isOver65,
      icon: BadgeCheck,
      sourceField: 'dateOfBirth',
      description: 'Proves you are at least 65 without revealing your date of birth.',
    },
    {
      id: 'isEuCitizen',
      title: 'EU Citizenship',
      claim: 'EU Citizen',
      result: claims.isEuCitizen,
      icon: Globe,
      sourceField: 'nationality',
      description: 'Proves EU citizenship without revealing your specific nationality.',
    },
    {
      id: 'isResident',
      title: 'Residency',
      claim: 'Verified Resident',
      result: claims.isResident,
      icon: MapPin,
      sourceField: 'isResident',
      description: 'Proves you have a verified residency status.',
    },
    {
      id: 'verificationLevel',
      title: 'Verification Level',
      claim: claims.verificationLevel,
      result: true,
      icon: Shield,
      sourceField: 'verificationLevel',
      description: 'Shows the level of identity verification completed.',
    },
  ]
}

/**
 * Get proof predicates for a proof ID.
 * Returns predicate requests for ZK proofs that prove claims
 * without revealing the underlying attribute values.
 */
export function getProofPredicates(proofId: string): PredicateRequest[] {
  switch (proofId) {
    case 'isOver18':
      return [
        {
          attribute: 'dateOfBirth',
          op: 'GreaterOrEqual',
          value: '18',
        },
      ]
    case 'isOver21':
      return [
        {
          attribute: 'dateOfBirth',
          op: 'GreaterOrEqual',
          value: '21',
        },
      ]
    case 'isOver65':
      return [
        {
          attribute: 'dateOfBirth',
          op: 'GreaterOrEqual',
          value: '65',
        },
      ]
    case 'isEuCitizen':
      return [
        {
          attribute: 'nationality',
          op: 'InSet',
          value: JSON.stringify(EU_COUNTRIES),
        },
      ]
    case 'isResident':
      return [
        {
          attribute: 'isResident',
          op: 'GreaterOrEqual',
          value: '1',
        },
      ]
    case 'verificationLevel':
      return [
        {
          attribute: 'verificationLevel',
          op: 'GreaterOrEqual',
          value: '1',
        },
      ]
    default:
      return []
  }
}
