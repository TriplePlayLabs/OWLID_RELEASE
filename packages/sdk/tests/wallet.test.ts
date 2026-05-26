import { describe, expect, test } from 'bun:test'
import { matchDcqlAgainst } from '../src/wallet.js'
import type { WalletCredential } from '../src/storage.js'
import type { DcqlRequest } from '@owlid/verifier-client'

function cred(over: Partial<WalletCredential>): WalletCredential {
  return {
    credentialId: over.credentialId ?? 'cred',
    sdJwtVc: over.sdJwtVc ?? 'eyJ.eyJ.sig~D~',
    issuer: over.issuer ?? 'did:web:issuer',
    providerId: over.providerId ?? 'didit',
    issuedAt: over.issuedAt ?? '2026-05-20T10:00:00.000Z',
    cardShape: over.cardShape ?? { kind: 'passport' },
    verifiedClaims: over.verifiedClaims ?? {},
    holderPublicKeyHex: over.holderPublicKeyHex ?? 'aa',
  }
}

describe('matchDcqlAgainst', () => {
  test('empty wallet → not satisfiable, reason mentions cred id', () => {
    const query: DcqlRequest = {
      credentials: [{ id: 'passport', format: 'dc+sd-jwt', claims: [] }],
    }
    const r = matchDcqlAgainst([], query)
    expect(r.satisfiable).toBe(false)
    expect(r.reason).toContain('passport')
    expect(r.entries[0]!.candidates).toEqual([])
  })

  test('wrong format → no candidate', () => {
    const r = matchDcqlAgainst([cred({ credentialId: 'a' })], {
      credentials: [{ id: 'q', format: 'mso_mdoc', claims: [] }],
    })
    expect(r.satisfiable).toBe(false)
    expect(r.entries[0]!.candidates).toEqual([])
  })

  test('claim path missing → credential filtered out', () => {
    const a = cred({ credentialId: 'a', verifiedClaims: { isOver18: true } })
    const b = cred({ credentialId: 'b', verifiedClaims: {} })
    const r = matchDcqlAgainst([a, b], {
      credentials: [
        {
          id: 'q',
          format: 'dc+sd-jwt',
          claims: [{ id: 'over_18', path: ['isOver18'] }],
        },
      ],
    })
    expect(r.satisfiable).toBe(true)
    expect(r.entries[0]!.candidates.map((c) => c.credentialId)).toEqual(['a'])
    expect(r.entries[0]!.disclosures).toEqual(['isOver18'])
  })

  test('claim values restrict matching', () => {
    const a = cred({ credentialId: 'a', verifiedClaims: { nationality: 'NL' } })
    const b = cred({ credentialId: 'b', verifiedClaims: { nationality: 'US' } })
    const r = matchDcqlAgainst([a, b], {
      credentials: [
        {
          id: 'q',
          format: 'dc+sd-jwt',
          claims: [{ path: ['nationality'], values: ['NL', 'BE'] }],
        },
      ],
    })
    expect(r.entries[0]!.candidates.map((c) => c.credentialId)).toEqual(['a'])
  })

  test('two credentials both contribute → all satisfied without credential_sets', () => {
    const passport = cred({
      credentialId: 'p',
      providerId: 'didit',
      verifiedClaims: { isOver18: true, nationality: 'NL' },
    })
    const google = cred({
      credentialId: 'g',
      providerId: 'google',
      verifiedClaims: { emailVerified: true, email: 'jane@x' },
    })
    const r = matchDcqlAgainst([passport, google], {
      credentials: [
        {
          id: 'p',
          format: 'dc+sd-jwt',
          claims: [{ path: ['isOver18'] }],
        },
        {
          id: 'e',
          format: 'dc+sd-jwt',
          claims: [{ path: ['emailVerified'] }],
        },
      ],
    })
    expect(r.satisfiable).toBe(true)
    expect(r.entries.map((e) => e.candidates.map((c) => c.credentialId))).toEqual([['p'], ['g']])
  })

  test('credential_sets OR satisfied by either branch', () => {
    const passport = cred({ credentialId: 'p', verifiedClaims: { isOver18: true } })
    const google = cred({ credentialId: 'g', verifiedClaims: { emailVerified: true } })
    const baseQuery = (): DcqlRequest => ({
      credentials: [
        { id: 'passport', format: 'dc+sd-jwt', claims: [{ path: ['isOver18'] }] },
        { id: 'gmail', format: 'dc+sd-jwt', claims: [{ path: ['emailVerified'] }] },
      ],
      credentialSets: [{ options: [['passport'], ['gmail']], required: true }],
    })

    expect(matchDcqlAgainst([passport], baseQuery()).satisfiable).toBe(true)
    expect(matchDcqlAgainst([google], baseQuery()).satisfiable).toBe(true)
    expect(matchDcqlAgainst([], baseQuery()).satisfiable).toBe(false)
  })

  test('credential_sets AND-row needs every id', () => {
    const passport = cred({ credentialId: 'p', verifiedClaims: { isOver18: true } })
    const google = cred({ credentialId: 'g', verifiedClaims: { emailVerified: true } })

    const both: DcqlRequest = {
      credentials: [
        { id: 'p', format: 'dc+sd-jwt', claims: [{ path: ['isOver18'] }] },
        { id: 'e', format: 'dc+sd-jwt', claims: [{ path: ['emailVerified'] }] },
      ],
      credentialSets: [{ options: [['p', 'e']], required: true }],
    }
    expect(matchDcqlAgainst([passport, google], both).satisfiable).toBe(true)
    expect(matchDcqlAgainst([passport], both).satisfiable).toBe(false)
    expect(matchDcqlAgainst([google], both).satisfiable).toBe(false)
  })

  test('optional credential_set (required:false) never blocks', () => {
    const r = matchDcqlAgainst([], {
      credentials: [{ id: 'p', format: 'dc+sd-jwt', claims: [] }],
      credentialSets: [{ options: [['p']], required: false }],
    })
    expect(r.satisfiable).toBe(true)
  })

  test('multiple candidates returned for the same query (batch siblings)', () => {
    const earlier = cred({
      credentialId: 'b1',
      issuedAt: '2026-05-19T10:00:00.000Z',
      verifiedClaims: { isOver18: true },
    })
    const later = cred({
      credentialId: 'b2',
      issuedAt: '2026-05-20T10:00:00.000Z',
      verifiedClaims: { isOver18: true },
    })
    const r = matchDcqlAgainst([earlier, later], {
      credentials: [{ id: 'q', format: 'dc+sd-jwt', claims: [{ path: ['isOver18'] }] }],
    })
    expect(r.entries[0]!.candidates).toHaveLength(2)
    // Insertion order is preserved on the candidates list; the
    // selector inside present() picks newest-by-issuedAt.
    expect(r.entries[0]!.candidates.map((c) => c.credentialId)).toEqual(['b1', 'b2'])
  })
})
