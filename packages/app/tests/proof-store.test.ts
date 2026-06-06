import { beforeEach, describe, expect, mock, test } from 'bun:test'

let saved: Array<{ id: string; predicateId: string; createdAt: string; result: boolean }> = []

mock.module('@owlid/sdk', () => ({
  proofStorage: {
    saveProofs: async (proofs: typeof saved) => {
      saved.push(...proofs)
    },
  },
}))

const { humanizePredicate, proofRecordsFromPresentation, recordProofs } =
  await import('../src/lib/proof-store')

beforeEach(() => {
  saved = []
})

describe('humanizePredicate', () => {
  test('turns snake/kebab ids into a readable label', () => {
    expect(humanizePredicate('age_over_18')).toBe('Age over 18')
    expect(humanizePredicate('nationality-in')).toBe('Nationality in')
  })

  test('capitalizes a single token and leaves spaced labels intact', () => {
    expect(humanizePredicate('residency')).toBe('Residency')
    expect(humanizePredicate('Already Spaced')).toBe('Already Spaced')
  })

  test('falls back to the raw id when nothing usable remains', () => {
    expect(humanizePredicate('___')).toBe('___')
  })
})

describe('proofRecordsFromPresentation', () => {
  const vpToken = { age_over_18: ['pres-A'], residency: ['pres-B'] }

  test('maps each answered DCQL id to a record', () => {
    const records = proofRecordsFromPresentation(
      [{ dcqlId: 'age_over_18' }, { dcqlId: 'residency' }],
      vpToken,
      { verifierName: 'Acme Bar' },
    )
    expect(records).toEqual([
      {
        predicateId: 'age_over_18',
        claim: 'Age over 18',
        name: 'Acme Bar',
        presentation: 'pres-A',
        result: true,
      },
      {
        predicateId: 'residency',
        claim: 'Residency',
        name: 'Acme Bar',
        presentation: 'pres-B',
        result: true,
      },
    ])
  })

  test('skips DCQL ids with no presentation in the vp_token', () => {
    const records = proofRecordsFromPresentation([{ dcqlId: 'missing' }], vpToken)
    expect(records).toEqual([])
  })

  test('falls back to the humanized predicate when no verifier name is given', () => {
    const [record] = proofRecordsFromPresentation([{ dcqlId: 'age_over_18' }], vpToken, {
      verifierName: '   ',
    })
    expect(record!.name).toBe('Age over 18')
  })
})

describe('recordProofs', () => {
  test('assigns a unique id per proof and a shared timestamp', async () => {
    const proofs = await recordProofs([
      { predicateId: 'age_over_18', name: 'V', claim: 'Age over 18', presentation: 'a' },
      { predicateId: 'age_over_18', name: 'V', claim: 'Age over 18', presentation: 'b' },
    ])

    expect(proofs).toHaveLength(2)
    expect(proofs[0]!.id).not.toBe(proofs[1]!.id)
    // Re-presenting the same predicate must append, never overwrite.
    expect(saved).toHaveLength(2)
    expect(saved[0]!.createdAt).toBe(saved[1]!.createdAt)
  })

  test('defaults result to true when omitted', async () => {
    await recordProofs([{ predicateId: 'p', name: 'n', claim: 'c', presentation: 'x' }])
    expect(saved[0]!.result).toBe(true)
  })

  test('preserves an explicit false result', async () => {
    await recordProofs([
      { predicateId: 'p', name: 'n', claim: 'c', presentation: 'x', result: false },
    ])
    expect(saved[0]!.result).toBe(false)
  })

  test('does not touch storage for an empty input', async () => {
    const proofs = await recordProofs([])
    expect(proofs).toEqual([])
    expect(saved).toHaveLength(0)
  })
})
