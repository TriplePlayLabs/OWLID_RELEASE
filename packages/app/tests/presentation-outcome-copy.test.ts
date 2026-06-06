/**
 * Regression for GH #12 — "On my mobile it says verified, on the verifier
 * it says something else".
 *
 * The holder's terminal screen used to read "Verified", but the holder only
 * knows the proof was SENT — the verifier decides accept/reject. The copy
 * must stay outcome-neutral so the two screens can't contradict each other.
 */
import { describe, expect, test } from 'bun:test'
import {
  PRESENTATION_SHARED_TITLE,
  PRESENTATION_SHARED_DESCRIPTION,
} from '../src/features/identity/presentation/outcome-copy'

describe('holder presentation outcome copy (#12)', () => {
  test('title does not claim verification', () => {
    expect(PRESENTATION_SHARED_TITLE).toBe('Shared')
    expect(PRESENTATION_SHARED_TITLE.toLowerCase()).not.toContain('verif')
  })

  test('description defers the result to the verifier', () => {
    const d = PRESENTATION_SHARED_DESCRIPTION.toLowerCase()
    expect(d).toContain('sent')
    expect(d).toContain('verifier')
    // Must not assert an accept/reject outcome the holder cannot know.
    expect(d).not.toContain('verified')
    expect(d).not.toContain('rejected')
  })
})
