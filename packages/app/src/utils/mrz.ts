/**
 * ICAO 9303 TD3 (passport) Machine-Readable Zone generator.
 *
 * Produces the two 44-character lines a real passport prints — name
 * field, document number, nationality, dates and the 7-3-1 weighted
 * check digits (including the line-2 composite check). Renders the
 * passport data page MRZ so it reads like a genuine document instead
 * of an ad-hoc string.
 */
import type { VerifiedClaims } from '@owlid/sdk'

const FILLER = '<'
const WEIGHTS = [7, 3, 1]

/** MRZ character value: 0-9 → 0-9, A-Z → 10-35, filler → 0. */
function charValue(ch: string): number {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48
  if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) - 55
  return 0
}

/** 7-3-1 weighted check digit over an MRZ field (ICAO 9303 §4.9). */
function checkDigit(field: string): string {
  let sum = 0
  for (let i = 0; i < field.length; i++) {
    sum += charValue(field[i]!) * WEIGHTS[i % 3]!
  }
  return String(sum % 10)
}

function pad(s: string, len: number): string {
  return (s + FILLER.repeat(len)).slice(0, len)
}

/** Latin transliteration: strip accents, A-Z only, everything else → filler. */
function transliterate(s: string): string {
  return s
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z]/g, FILLER)
    .replace(/<+/g, FILLER)
    .replace(/^<|<$/g, '')
}

/** Keep only A-Z0-9 (document / personal numbers). */
function alnum(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** ISO-8601 `YYYY-MM-DD` → MRZ `YYMMDD`; unknown → filler. */
function mrzDate(iso?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((iso ?? '').trim())
  return m ? m[1]!.slice(2) + m[2]! + m[3]! : FILLER.repeat(6)
}

function sexChar(gender?: string): string {
  const g = (gender ?? '').trim().toLowerCase()
  if (g.startsWith('m')) return 'M'
  if (g.startsWith('f')) return 'F'
  return FILLER
}

/** Map a 2-letter / full-name nationality to the ICAO 3-letter code. */
const ALPHA3: Record<string, string> = {
  AT: 'AUT',
  BE: 'BEL',
  BG: 'BGR',
  HR: 'HRV',
  CY: 'CYP',
  CZ: 'CZE',
  DK: 'DNK',
  EE: 'EST',
  FI: 'FIN',
  FR: 'FRA',
  DE: 'DEU',
  GR: 'GRC',
  HU: 'HUN',
  IE: 'IRL',
  IT: 'ITA',
  LV: 'LVA',
  LT: 'LTU',
  LU: 'LUX',
  MT: 'MLT',
  NL: 'NLD',
  PL: 'POL',
  PT: 'PRT',
  RO: 'ROU',
  SK: 'SVK',
  SI: 'SVN',
  ES: 'ESP',
  SE: 'SWE',
  GB: 'GBR',
  US: 'USA',
  CA: 'CAN',
  AU: 'AUS',
  CH: 'CHE',
  NO: 'NOR',
  IS: 'ISL',
  JP: 'JPN',
  BR: 'BRA',
  TR: 'TUR',
}
const NAME_ALPHA3: Record<string, string> = {
  AUSTRIAN: 'AUT',
  AUSTRIA: 'AUT',
  BELGIAN: 'BEL',
  BELGIUM: 'BEL',
  CROATIAN: 'HRV',
  CROATIA: 'HRV',
  CZECH: 'CZE',
  DANISH: 'DNK',
  DENMARK: 'DNK',
  DUTCH: 'NLD',
  NETHERLANDS: 'NLD',
  FINNISH: 'FIN',
  FINLAND: 'FIN',
  FRENCH: 'FRA',
  FRANCE: 'FRA',
  GERMAN: 'DEU',
  GERMANY: 'DEU',
  GREEK: 'GRC',
  GREECE: 'GRC',
  IRISH: 'IRL',
  IRELAND: 'IRL',
  ITALIAN: 'ITA',
  ITALY: 'ITA',
  POLISH: 'POL',
  POLAND: 'POL',
  PORTUGUESE: 'PRT',
  PORTUGAL: 'PRT',
  SPANISH: 'ESP',
  SPAIN: 'ESP',
  SWEDISH: 'SWE',
  SWEDEN: 'SWE',
  BRITISH: 'GBR',
  'UNITED KINGDOM': 'GBR',
  AMERICAN: 'USA',
  'UNITED STATES': 'USA',
  USA: 'USA',
  CANADIAN: 'CAN',
  CANADA: 'CAN',
  SWISS: 'CHE',
  SWITZERLAND: 'CHE',
  NORWEGIAN: 'NOR',
  NORWAY: 'NOR',
}

/** Best-effort ICAO 3-letter country code from any nationality format. */
export function toAlpha3(input: string): string {
  const v = (input ?? '').trim()
  if (!v) return 'XXX'
  const upper = v.toUpperCase()
  if (upper.length === 3 && /^[A-Z]{3}$/.test(upper)) return upper
  if (upper.length === 2 && ALPHA3[upper]) return ALPHA3[upper]!
  return NAME_ALPHA3[upper] ?? 'XXX'
}

/** Surname `<<` given-names, padded to the 39-char name field. */
function nameField(surname: string, given: string): string {
  return pad(`${transliterate(surname)}<<${transliterate(given)}`, 39)
}

export interface Td3Mrz {
  line1: string
  line2: string
}

/** Build the two ICAO 9303 TD3 MRZ lines (44 chars each) for a holder. */
export function buildTd3Mrz(c: VerifiedClaims): Td3Mrz {
  const issuing = toAlpha3(c.issuingCountry || c.nationality || '')
  const nationality = toAlpha3(c.nationality || c.issuingCountry || '')

  const line1 = pad('P' + FILLER + issuing + nameField(c.lastName ?? '', c.firstName ?? ''), 44)

  const docNo = pad(alnum(c.passportNumber || c.documentNumber || c.nationalId || ''), 9)
  const docCd = checkDigit(docNo)
  const dob = mrzDate(c.dateOfBirth)
  const dobCd = checkDigit(dob)
  const sex = sexChar(c.gender)
  const expiry = mrzDate(c.documentExpiry)
  const expiryCd = checkDigit(expiry)
  const personal = pad(alnum(c.nationalId || ''), 14)
  const personalCd = checkDigit(personal)
  // Composite check digit covers doc-number, DOB and expiry blocks
  // (positions 1-10, 14-20, 22-43) — nationality and sex are excluded.
  const compositeCd = checkDigit(
    docNo + docCd + dob + dobCd + expiry + expiryCd + personal + personalCd,
  )

  const line2 = pad(
    docNo +
      docCd +
      nationality +
      dob +
      dobCd +
      sex +
      expiry +
      expiryCd +
      personal +
      personalCd +
      compositeCd,
    44,
  )

  return { line1, line2 }
}
