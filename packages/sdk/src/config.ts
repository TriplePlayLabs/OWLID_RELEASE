/**
 * Re-export of the runtime configuration helpers, which now live in
 * `@owlid/config`. This file exists only to keep `@owlid/sdk` consumers that
 * already import from `'@owlid/sdk'` working without a refactor — new code
 * (and every client package) imports from `'@owlid/config'` directly.
 */
export * from '@owlid/config'
