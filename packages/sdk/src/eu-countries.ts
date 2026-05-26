/**
 * @deprecated Re-export of the canonical EU country list from
 * `./countries`. Kept so existing imports
 * (`import { EU_ALPHA2 } from '@owlid/sdk'`) don't break. New code
 * should use `EU_COUNTRIES` (and the rest of the country helpers) from
 * `./countries` directly.
 */
export { EU_COUNTRIES as EU_ALPHA2 } from './countries.js'
