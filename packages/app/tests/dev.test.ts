/**
 * Regression for QA #5 — recurring React #419. Its source was the
 * TanStack Router + React Query devtools rendering in the production SSR
 * shell. `devtoolsEnabled()` gates them; this pins that production never
 * renders them (and dev still does).
 */
import { describe, expect, test } from 'bun:test'
import { devtoolsEnabled } from '../src/lib/dev'

describe('devtoolsEnabled (#5 / #419)', () => {
  test('off in production', () => {
    expect(devtoolsEnabled('production')).toBe(false)
  })

  test('on in development', () => {
    expect(devtoolsEnabled('development')).toBe(true)
  })

  test('on under test / when unset (non-prod)', () => {
    expect(devtoolsEnabled('test')).toBe(true)
    expect(devtoolsEnabled(undefined)).toBe(true)
  })
})
