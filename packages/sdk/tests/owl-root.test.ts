import { describe, expect, test } from 'bun:test'
import { bytesToHex } from '@noble/hashes/utils'
import {
  buildOwlRootTree,
  claimCommit,
  claimValue32,
  owlRootBytesLE,
  salt32For,
} from '../src/midnight/owl-root.js'

// Cross-runtime parity with owl_proof_system::attestation (Rust test
// owl_root_vector::owl_root_fixed_vector). If these drift, the wallet's
// owl_root won't match the issuer's signed one and every attestation fails.
// Standard SD-JWT claim names + a kyc label ("high" → level 3) — exactly what
// the issuer signs and the disclosures carry.
const FIXED_CLAIMS = [
  { name: 'verification_level', value: 'high', salt: 'saltAAA' },
  { name: 'birthdate', value: '2006-06-24', salt: 'saltBBB' },
  { name: 'given_name', value: 'Ada', salt: 'saltCCC' }, // non-predicate, not bound
]

describe('owl_root parity', () => {
  test('owl_root matches the Rust issuer vector', () => {
    const built = buildOwlRootTree(FIXED_CLAIMS)
    expect(bytesToHex(owlRootBytesLE(built))).toBe(
      'cb4b32bc1c2a108183ec21e89000d1a1ce84cf94721ed151142a192ea2ea714a',
    )
  })

  test('kyc claim commitment matches Rust (label "high" → level 3)', () => {
    const salt32 = salt32For('saltAAA')
    const v32 = claimValue32('verification_level', 'high')!
    expect(bytesToHex(claimCommit('verification_level', v32, salt32))).toBe(
      'a4e9513ff4da36a51d92050629b452c2e0a2d8bcd7688476f87de0646659e16f',
    )
  })

  test('non-predicate claims are not bound', () => {
    expect(claimValue32('given_name', 'Ada')).toBeNull()
    expect(claimValue32('verification_level', 'high')).not.toBeNull()
  })

  test('a Merkle path exists for the bound kyc claim', () => {
    const built = buildOwlRootTree(FIXED_CLAIMS)
    expect(built.indexByName.has('verification_level')).toBe(true)
    expect(built.indexByName.has('given_name')).toBe(false)
  })
})
