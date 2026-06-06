import { describe, expect, test } from 'bun:test'
import type { StoredProof } from '@owlid/sdk'
import {
  buildQrPayload,
  filterProofs,
  groupProofsByDay,
  relativeTime,
} from '../src/lib/proof-display'

function proof(overrides: Partial<StoredProof> = {}): StoredProof {
  return {
    id: overrides.id ?? 'id-1',
    predicateId: 'age_over_18',
    name: 'Acme Bar',
    claim: 'Age over 18',
    result: true,
    presentation: 'pres-A',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString()
}

describe('buildQrPayload', () => {
  test('returns the raw compact presentation', () => {
    expect(buildQrPayload(proof({ presentation: 'wire~format~kb' }))).toBe('wire~format~kb')
  })
})

describe('filterProofs', () => {
  const items = [
    proof({ id: '1', claim: 'Age over 18', name: 'Acme Bar', predicateId: 'age_over_18' }),
    proof({ id: '2', claim: 'Resident of NL', name: 'Gov Portal', predicateId: 'residency' }),
  ]

  test('empty / whitespace query returns the list unchanged', () => {
    expect(filterProofs(items, '')).toBe(items)
    expect(filterProofs(items, '   ')).toBe(items)
  })

  test('matches on claim, name, and predicate id, case-insensitively', () => {
    expect(filterProofs(items, 'acme').map((p) => p.id)).toEqual(['1'])
    expect(filterProofs(items, 'RESIDENCY').map((p) => p.id)).toEqual(['2'])
    expect(filterProofs(items, 'over').map((p) => p.id)).toEqual(['1'])
  })

  test('returns empty when nothing matches', () => {
    expect(filterProofs(items, 'zzz')).toEqual([])
  })
})

describe('groupProofsByDay', () => {
  test('buckets by Today / Yesterday / Earlier this week / month, newest first', () => {
    const groups = groupProofsByDay([
      proof({ id: 'old', createdAt: daysAgo(40) }),
      proof({ id: 'today', createdAt: daysAgo(0) }),
      proof({ id: 'week', createdAt: daysAgo(3) }),
      proof({ id: 'yest', createdAt: daysAgo(1) }),
    ])

    const labels = groups.map((g) => g.label)
    expect(labels[0]).toBe('Today')
    expect(labels[1]).toBe('Yesterday')
    expect(labels[2]).toBe('Earlier this week')
    expect(labels).toHaveLength(4)
    expect(groups[0]!.entries[0]!.id).toBe('today')
  })

  test('collapses multiple proofs from the same day into one group', () => {
    const groups = groupProofsByDay([
      proof({ id: 'a', createdAt: daysAgo(0) }),
      proof({ id: 'b', createdAt: daysAgo(0) }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.entries).toHaveLength(2)
  })

  test('empty input yields no groups', () => {
    expect(groupProofsByDay([])).toEqual([])
  })
})

describe('relativeTime', () => {
  test('reports the coarsest matching unit', () => {
    expect(relativeTime(new Date(Date.now() - 30_000))).toBe('30s ago')
    expect(relativeTime(new Date(Date.now() - 5 * 60_000))).toBe('5m ago')
    expect(relativeTime(new Date(Date.now() - 2 * 3_600_000))).toBe('2h ago')
    expect(relativeTime(new Date(Date.now() - 3 * 86_400_000))).toBe('3d ago')
    expect(relativeTime(new Date(Date.now() - 14 * 86_400_000))).toBe('2w ago')
  })
})
