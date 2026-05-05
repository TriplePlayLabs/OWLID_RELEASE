// Mirror of the alpha-2 portion of `EU_COUNTRIES` in the issuer service.
// The issuer normalises nationality to alpha-2 at issuance, so the holder's
// predicate-side list only needs alpha-2 codes. Keep in sync when EU
// membership changes.
export const EU_ALPHA2 = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
] as const
