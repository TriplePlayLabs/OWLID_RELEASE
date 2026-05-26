/**
 * Single source of truth for ISO 3166-1 alpha-2 country data across the
 * OwlID stack. Backed by the `countries-list` npm package (full ISO
 * 3166-1, native names, regions, calling codes) plus an EU-27 overlay
 * since `countries-list` carries continents, not political-union
 * membership.
 *
 * Use this everywhere instead of hand-maintaining EU country lists in
 * five files — historically the SDK, the verifier app, the
 * proof-system, and the holder app all kept their own copies and drifted.
 */

import { countries as RAW_COUNTRIES } from 'countries-list'

export interface Country {
  /** ISO 3166-1 alpha-2 (e.g. `"NL"`). */
  alpha2: string
  /** English short name (e.g. `"Netherlands"`). */
  name: string
  /** Native name (`"Nederland"`). */
  native: string
  /** Continent code (`AF` / `AN` / `AS` / `EU` / `NA` / `OC` / `SA`). */
  continent: string
  /** EU-27 member as of 2026. Maintained here because political-union
   *  membership doesn't match continent (UK, CH, NO are EU continent
   *  but not EU members). */
  eu: boolean
}

/** EU-27 member states (alpha-2). Maintain when membership changes. */
const EU_27 = new Set<string>([
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
])

/** Every ISO 3166-1 country, alpha-2 keyed. */
export const ALL_COUNTRIES: readonly Country[] = Object.entries(RAW_COUNTRIES)
  .map(([alpha2, c]) => ({
    alpha2,
    name: c.name,
    native: c.native,
    continent: c.continent,
    eu: EU_27.has(alpha2),
  }))
  .sort((a, b) => a.name.localeCompare(b.name))

const BY_ALPHA2: Record<string, Country> = Object.create(null)
for (const c of ALL_COUNTRIES) {
  BY_ALPHA2[c.alpha2] = c
}

/** Look up a country by alpha-2; `undefined` for unknown codes. */
export function countryByAlpha2(code: string): Country | undefined {
  return BY_ALPHA2[code.toUpperCase()]
}

/** Look up only the English name; falls back to the code itself. */
export function countryName(code: string): string {
  return BY_ALPHA2[code.toUpperCase()]?.name ?? code.toUpperCase()
}

/** Validate that `code` is a registered ISO 3166-1 alpha-2 letter pair. */
export function isAlpha2(code: string): boolean {
  if (typeof code !== 'string' || code.length !== 2) return false
  return BY_ALPHA2[code.toUpperCase()] !== undefined
}

/** True iff the country is an EU-27 member. */
export function isEuCountry(code: string): boolean {
  const c = BY_ALPHA2[code.toUpperCase()]
  return c?.eu ?? false
}

/** EU-27 alpha-2 codes, sorted alphabetically. The canonical EU list
 *  every other package re-exports — DO NOT redefine in callers. */
export const EU_COUNTRIES: readonly string[] = ALL_COUNTRIES.filter((c) => c.eu).map(
  (c) => c.alpha2,
)

/** Curated presets for the verifier UI's allowed-set picker. */
export const COUNTRY_PRESETS: ReadonlyArray<{ label: string; codes: readonly string[] }> = [
  { label: 'EU-27', codes: EU_COUNTRIES },
  { label: 'EEA', codes: [...EU_COUNTRIES, 'IS', 'LI', 'NO'] },
  { label: 'DACH', codes: ['DE', 'AT', 'CH'] },
  { label: 'Nordics', codes: ['DK', 'FI', 'IS', 'NO', 'SE'] },
  { label: 'Benelux', codes: ['BE', 'NL', 'LU'] },
]

/** ISO 3166-1 alpha-3 → alpha-2 lookup. Didit, eIDAS, and most KYC
 *  providers ship alpha-3 codes (`"NLD"`, `"DEU"`, `"GBR"`); on-chain
 *  attestations + the DCQL routing layer both speak alpha-2. Truncating
 *  alpha-3[0:2] is wrong for Slovakia (SVK→SV instead of SK), Slovenia
 *  (SVN→SV instead of SI), and a handful of others, so we maintain the
 *  full table here rather than relying on coincidence. */
const ALPHA3_TO_ALPHA2: Record<string, string> = {
  ABW: 'AW',
  AFG: 'AF',
  AGO: 'AO',
  AIA: 'AI',
  ALA: 'AX',
  ALB: 'AL',
  AND: 'AD',
  ARE: 'AE',
  ARG: 'AR',
  ARM: 'AM',
  ASM: 'AS',
  ATA: 'AQ',
  ATF: 'TF',
  ATG: 'AG',
  AUS: 'AU',
  AUT: 'AT',
  AZE: 'AZ',
  BDI: 'BI',
  BEL: 'BE',
  BEN: 'BJ',
  BES: 'BQ',
  BFA: 'BF',
  BGD: 'BD',
  BGR: 'BG',
  BHR: 'BH',
  BHS: 'BS',
  BIH: 'BA',
  BLM: 'BL',
  BLR: 'BY',
  BLZ: 'BZ',
  BMU: 'BM',
  BOL: 'BO',
  BRA: 'BR',
  BRB: 'BB',
  BRN: 'BN',
  BTN: 'BT',
  BVT: 'BV',
  BWA: 'BW',
  CAF: 'CF',
  CAN: 'CA',
  CCK: 'CC',
  CHE: 'CH',
  CHL: 'CL',
  CHN: 'CN',
  CIV: 'CI',
  CMR: 'CM',
  COD: 'CD',
  COG: 'CG',
  COK: 'CK',
  COL: 'CO',
  COM: 'KM',
  CPV: 'CV',
  CRI: 'CR',
  CUB: 'CU',
  CUW: 'CW',
  CXR: 'CX',
  CYM: 'KY',
  CYP: 'CY',
  CZE: 'CZ',
  DEU: 'DE',
  DJI: 'DJ',
  DMA: 'DM',
  DNK: 'DK',
  DOM: 'DO',
  DZA: 'DZ',
  ECU: 'EC',
  EGY: 'EG',
  ERI: 'ER',
  ESH: 'EH',
  ESP: 'ES',
  EST: 'EE',
  ETH: 'ET',
  FIN: 'FI',
  FJI: 'FJ',
  FLK: 'FK',
  FRA: 'FR',
  FRO: 'FO',
  FSM: 'FM',
  GAB: 'GA',
  GBR: 'GB',
  GEO: 'GE',
  GGY: 'GG',
  GHA: 'GH',
  GIB: 'GI',
  GIN: 'GN',
  GLP: 'GP',
  GMB: 'GM',
  GNB: 'GW',
  GNQ: 'GQ',
  GRC: 'GR',
  GRD: 'GD',
  GRL: 'GL',
  GTM: 'GT',
  GUF: 'GF',
  GUM: 'GU',
  GUY: 'GY',
  HKG: 'HK',
  HMD: 'HM',
  HND: 'HN',
  HRV: 'HR',
  HTI: 'HT',
  HUN: 'HU',
  IDN: 'ID',
  IMN: 'IM',
  IND: 'IN',
  IOT: 'IO',
  IRL: 'IE',
  IRN: 'IR',
  IRQ: 'IQ',
  ISL: 'IS',
  ISR: 'IL',
  ITA: 'IT',
  JAM: 'JM',
  JEY: 'JE',
  JOR: 'JO',
  JPN: 'JP',
  KAZ: 'KZ',
  KEN: 'KE',
  KGZ: 'KG',
  KHM: 'KH',
  KIR: 'KI',
  KNA: 'KN',
  KOR: 'KR',
  KWT: 'KW',
  LAO: 'LA',
  LBN: 'LB',
  LBR: 'LR',
  LBY: 'LY',
  LCA: 'LC',
  LIE: 'LI',
  LKA: 'LK',
  LSO: 'LS',
  LTU: 'LT',
  LUX: 'LU',
  LVA: 'LV',
  MAC: 'MO',
  MAF: 'MF',
  MAR: 'MA',
  MCO: 'MC',
  MDA: 'MD',
  MDG: 'MG',
  MDV: 'MV',
  MEX: 'MX',
  MHL: 'MH',
  MKD: 'MK',
  MLI: 'ML',
  MLT: 'MT',
  MMR: 'MM',
  MNE: 'ME',
  MNG: 'MN',
  MNP: 'MP',
  MOZ: 'MZ',
  MRT: 'MR',
  MSR: 'MS',
  MTQ: 'MQ',
  MUS: 'MU',
  MWI: 'MW',
  MYS: 'MY',
  MYT: 'YT',
  NAM: 'NA',
  NCL: 'NC',
  NER: 'NE',
  NFK: 'NF',
  NGA: 'NG',
  NIC: 'NI',
  NIU: 'NU',
  NLD: 'NL',
  NOR: 'NO',
  NPL: 'NP',
  NRU: 'NR',
  NZL: 'NZ',
  OMN: 'OM',
  PAK: 'PK',
  PAN: 'PA',
  PCN: 'PN',
  PER: 'PE',
  PHL: 'PH',
  PLW: 'PW',
  PNG: 'PG',
  POL: 'PL',
  PRI: 'PR',
  PRK: 'KP',
  PRT: 'PT',
  PRY: 'PY',
  PSE: 'PS',
  PYF: 'PF',
  QAT: 'QA',
  REU: 'RE',
  ROU: 'RO',
  RUS: 'RU',
  RWA: 'RW',
  SAU: 'SA',
  SDN: 'SD',
  SEN: 'SN',
  SGP: 'SG',
  SGS: 'GS',
  SHN: 'SH',
  SJM: 'SJ',
  SLB: 'SB',
  SLE: 'SL',
  SLV: 'SV',
  SMR: 'SM',
  SOM: 'SO',
  SPM: 'PM',
  SRB: 'RS',
  SSD: 'SS',
  STP: 'ST',
  SUR: 'SR',
  SVK: 'SK',
  SVN: 'SI',
  SWE: 'SE',
  SWZ: 'SZ',
  SXM: 'SX',
  SYC: 'SC',
  SYR: 'SY',
  TCA: 'TC',
  TCD: 'TD',
  TGO: 'TG',
  THA: 'TH',
  TJK: 'TJ',
  TKL: 'TK',
  TKM: 'TM',
  TLS: 'TL',
  TON: 'TO',
  TTO: 'TT',
  TUN: 'TN',
  TUR: 'TR',
  TUV: 'TV',
  TWN: 'TW',
  TZA: 'TZ',
  UGA: 'UG',
  UKR: 'UA',
  UMI: 'UM',
  URY: 'UY',
  USA: 'US',
  UZB: 'UZ',
  VAT: 'VA',
  VCT: 'VC',
  VEN: 'VE',
  VGB: 'VG',
  VIR: 'VI',
  VNM: 'VN',
  VUT: 'VU',
  WLF: 'WF',
  WSM: 'WS',
  YEM: 'YE',
  ZAF: 'ZA',
  ZMB: 'ZM',
  ZWE: 'ZW',
}

/** Convert any common country-code shape to ISO 3166-1 alpha-2.
 *  Returns `undefined` when the input isn't a known code (e.g. full
 *  English name) — callers should fall back to alternative lookup. */
export function toAlpha2(value: string): string | undefined {
  if (typeof value !== 'string') return undefined
  const upper = value.trim().toUpperCase()
  if (upper.length === 2 && BY_ALPHA2[upper]) return upper
  if (upper.length === 3 && ALPHA3_TO_ALPHA2[upper]) return ALPHA3_TO_ALPHA2[upper]
  return undefined
}
