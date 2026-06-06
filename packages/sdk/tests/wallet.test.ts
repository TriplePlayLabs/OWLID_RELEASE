import { describe, expect, test } from 'bun:test'
import { matchDcqlAgainst } from '../src/wallet.js'
import type { WalletCredential } from '../src/storage.js'
import type { DcqlRequest } from '@owlid/verifier-client'

function b64urlJson(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function sdJwtWithAttestations(attestations: unknown[]): string {
  const header = b64urlJson({ alg: 'none' })
  const payload = b64urlJson({ iss: 'did:web:issuer' })
  const disclosure = b64urlJson(['salt', 'owl_attestation', attestations])
  return `${header}.${payload}.sig~${disclosure}~`
}

function cred(over: Partial<WalletCredential>): WalletCredential {
  return {
    credentialId: over.credentialId ?? 'cred',
    issuer: over.issuer ?? 'did:web:issuer',
    providerId: over.providerId ?? 'didit',
    issuedAt: over.issuedAt ?? '2026-05-20T10:00:00.000Z',
    cardShape: over.cardShape ?? { kind: 'passport' },
    verifiedClaims: over.verifiedClaims ?? {},
    sdJwtVc: over.sdJwtVc ?? sdJwtWithAttestations([]),
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
    const a = cred({
      credentialId: 'a',
      sdJwtVc: sdJwtWithAttestations([{ predicate: 'age' }]),
    })
    const b = cred({ credentialId: 'b', verifiedClaims: {} })
    const r = matchDcqlAgainst([a, b], {
      credentials: [
        {
          id: 'q',
          format: 'dc+sd-jwt',
          claims: [{ id: 'over_18', path: ['age_over'], values: [18] }],
        },
      ],
    })
    expect(r.satisfiable).toBe(true)
    expect(r.entries[0]!.candidates.map((c) => c.credentialId)).toEqual(['a'])
    expect(r.entries[0]!.disclosures).toEqual([])
  })

  test('claim values restrict matching', () => {
    const a = cred({
      credentialId: 'a',
      sdJwtVc: sdJwtWithAttestations([{ predicate: 'nationality', country: 'NL' }]),
    })
    const b = cred({
      credentialId: 'b',
      sdJwtVc: sdJwtWithAttestations([{ predicate: 'nationality', country: 'US' }]),
    })
    const r = matchDcqlAgainst([a, b], {
      credentials: [
        {
          id: 'q',
          format: 'dc+sd-jwt',
          claims: [{ path: ['nationality_in'], values: ['NL', 'BE'] }],
        },
      ],
    })
    expect(r.entries[0]!.candidates.map((c) => c.credentialId)).toEqual(['a'])
  })

  test('two credentials both contribute → all satisfied without credential_sets', () => {
    const passport = cred({
      credentialId: 'p',
      providerId: 'didit',
      sdJwtVc: sdJwtWithAttestations([{ predicate: 'age' }]),
    })
    const google = cred({
      credentialId: 'g',
      providerId: 'google',
      sdJwtVc: sdJwtWithAttestations([{ predicate: 'email_verified' }]),
    })
    const r = matchDcqlAgainst([passport, google], {
      credentials: [
        {
          id: 'p',
          format: 'dc+sd-jwt',
          claims: [{ path: ['age_over'], values: [18] }],
        },
        {
          id: 'e',
          format: 'dc+sd-jwt',
          claims: [{ path: ['email_verified'] }],
        },
      ],
    })
    expect(r.satisfiable).toBe(true)
    expect(r.entries.map((e) => e.candidates.map((c) => c.credentialId))).toEqual([['p'], ['g']])
  })

  test('credential_sets OR satisfied by either branch', () => {
    const passport = cred({
      credentialId: 'p',
      sdJwtVc: sdJwtWithAttestations([{ predicate: 'age' }]),
    })
    const google = cred({
      credentialId: 'g',
      sdJwtVc: sdJwtWithAttestations([{ predicate: 'email_verified' }]),
    })
    const baseQuery = (): DcqlRequest => ({
      credentials: [
        { id: 'passport', format: 'dc+sd-jwt', claims: [{ path: ['age_over'], values: [18] }] },
        { id: 'gmail', format: 'dc+sd-jwt', claims: [{ path: ['email_verified'] }] },
      ],
      credentialSets: [{ options: [['passport'], ['gmail']], required: true }],
    })

    expect(matchDcqlAgainst([passport], baseQuery()).satisfiable).toBe(true)
    expect(matchDcqlAgainst([google], baseQuery()).satisfiable).toBe(true)
    expect(matchDcqlAgainst([], baseQuery()).satisfiable).toBe(false)
  })

  test('credential_sets AND-row needs every id', () => {
    const passport = cred({
      credentialId: 'p',
      sdJwtVc: sdJwtWithAttestations([{ predicate: 'age' }]),
    })
    const google = cred({
      credentialId: 'g',
      sdJwtVc: sdJwtWithAttestations([{ predicate: 'email_verified' }]),
    })

    const both: DcqlRequest = {
      credentials: [
        { id: 'p', format: 'dc+sd-jwt', claims: [{ path: ['age_over'], values: [18] }] },
        { id: 'e', format: 'dc+sd-jwt', claims: [{ path: ['email_verified'] }] },
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
      sdJwtVc: sdJwtWithAttestations([{ predicate: 'age' }]),
    })
    const later = cred({
      credentialId: 'b2',
      issuedAt: '2026-05-20T10:00:00.000Z',
      sdJwtVc: sdJwtWithAttestations([{ predicate: 'age' }]),
    })
    const r = matchDcqlAgainst([earlier, later], {
      credentials: [
        { id: 'q', format: 'dc+sd-jwt', claims: [{ path: ['age_over'], values: [18] }] },
      ],
    })
    expect(r.entries[0]!.candidates).toHaveLength(2)
    // Insertion order is preserved on the candidates list; the
    // selector inside present() picks newest-by-issuedAt.
    expect(r.entries[0]!.candidates.map((c) => c.credentialId)).toEqual(['b1', 'b2'])
  })
})
