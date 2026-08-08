// ============================================
// OwlID Verifier — catalog of checks & presets (from the design handoff)
// Each design check maps to a real registry predicate + verifier input
// so the configure-first UI produces a correct DCQL request.
// ============================================

import type { PredicateParamInput } from './App'

export type CheckGroup = 'Age' | 'Identity' | 'KYC' | 'Contact'
export type CheckIconKey = 'cake' | 'flag' | 'badge' | 'building' | 'beer' | 'lock' | 'mail'

export interface CheckDef {
  id: string
  label: string
  group: CheckGroup
  icon: CheckIconKey
}

export interface PresetDef {
  id: string
  name: string
  desc: string
  checks: string[]
  icon: CheckIconKey
}

export const CHECKS: CheckDef[] = [
  { id: 'age_18', label: 'Age 18 or older', group: 'Age', icon: 'cake' },
  { id: 'age_21', label: 'Age 21 or older', group: 'Age', icon: 'cake' },
  { id: 'age_65', label: 'Age 65 or older', group: 'Age', icon: 'cake' },
  { id: 'eu_citizen', label: 'EU citizenship', group: 'Identity', icon: 'flag' },
  { id: 'verified_resident', label: 'Verified resident', group: 'Identity', icon: 'building' },
  { id: 'kyc_basic', label: 'KYC: basic', group: 'KYC', icon: 'badge' },
  { id: 'kyc_substantial', label: 'KYC: substantial', group: 'KYC', icon: 'badge' },
  { id: 'kyc_high', label: 'KYC: high', group: 'KYC', icon: 'badge' },
  { id: 'email_verified', label: 'Verified email address', group: 'Contact', icon: 'mail' },
]

export const PRESETS: PresetDef[] = [
  {
    id: 'bar',
    name: 'Bar entry',
    desc: 'Age 18+ only — no other data',
    checks: ['age_18'],
    icon: 'beer',
  },
  {
    id: 'alcohol_us',
    name: 'Alcohol (US)',
    desc: 'Age 21+ only',
    checks: ['age_21'],
    icon: 'beer',
  },
  {
    id: 'kyc_std',
    name: 'KYC standard',
    desc: 'Substantial KYC + EU residency',
    checks: ['kyc_substantial', 'verified_resident'],
    icon: 'badge',
  },
  {
    id: 'kyc_high',
    name: 'KYC high',
    desc: 'High-assurance KYC for finance',
    checks: ['kyc_high', 'eu_citizen'],
    icon: 'lock',
  },
  {
    id: 'senior',
    name: 'Senior discount',
    desc: 'Proves age 65+',
    checks: ['age_65'],
    icon: 'cake',
  },
  {
    id: 'eu_resident',
    name: 'EU resident',
    desc: 'Citizenship + residency',
    checks: ['eu_citizen', 'verified_resident'],
    icon: 'flag',
  },
]

export const groupOrder: CheckGroup[] = ['Age', 'Identity', 'KYC', 'Contact']

export const checkById = (id: string): CheckDef | undefined => CHECKS.find((c) => c.id === id)

// EU-27 (ISO 3166-1 alpha-2) — the verifier's own policy set for the
// "EU citizenship" / "verified resident" presets, sent as verifier input
// to the nationality_in / residency_in predicates.
export const EU_COUNTRY_CODES: string[] = [
  'AT',
  'BE',
  'BG',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
]

/** How a design check resolves to a real registry predicate + the
 *  verifier-supplied input the wallet dispatches on. `predicateId` must
 *  match a registry id from `listPredicates()`. Checks without verifier
 *  input (e.g. email:verified) omit `param`. */
export interface CheckRequest {
  predicateId: string
  param?: PredicateParamInput
}

export const CHECK_REQUESTS: Record<string, CheckRequest> = {
  age_18: { predicateId: 'age:gte', param: { threshold: 18 } },
  age_21: { predicateId: 'age:gte', param: { threshold: 21 } },
  age_65: { predicateId: 'age:gte', param: { threshold: 65 } },
  eu_citizen: { predicateId: 'nationality:in', param: { countries: EU_COUNTRY_CODES } },
  verified_resident: { predicateId: 'residency:in', param: { countries: EU_COUNTRY_CODES } },
  kyc_basic: { predicateId: 'kyc:>=basic', param: { threshold: 1 } },
  kyc_substantial: { predicateId: 'kyc:>=substantial', param: { threshold: 2 } },
  kyc_high: { predicateId: 'kyc:>=high', param: { threshold: 3 } },
  email_verified: { predicateId: 'email:verified' },
}
