import { describe, test, expect, beforeAll } from 'bun:test'

import {
  KeyPair,
  Document,
  Credential,
  Token,
  type ProofRequest,
  type PredicateRequest,
} from '../index.js'

const VERIFICATION_URL = process.env.VERIFICATION_URL || 'http://localhost:8000'
const API_KEY = process.env.API_KEY || 'dev_key_12345678901234567890123456789012'

/**
 * Helper to call the verification service
 */
async function verifyCompactToken(compactToken: string, challenge: string) {
  const res = await fetch(`${VERIFICATION_URL}/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
    body: JSON.stringify({ token: compactToken, challenge }),
  })
  return { status: res.status, body: await res.json() }
}

async function addTrustedIssuer(publicKey: string, name: string) {
  const res = await fetch(`${VERIFICATION_URL}/trusted-issuers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
    body: JSON.stringify({ public_key: publicKey, name }),
  })
  return { status: res.status, body: await res.json() }
}

// Shared issuer keypair for all tests
let issuerKey: InstanceType<typeof KeyPair>
let ownerKey: InstanceType<typeof KeyPair>

describe('E2E: SDK → Compact Token → Verification Service', () => {
  beforeAll(async () => {
    // Check that the verification service is reachable
    const health = await fetch(`${VERIFICATION_URL}/health`).catch(() => null)
    if (!health || !health.ok) {
      throw new Error(
        `Verification service not reachable at ${VERIFICATION_URL}. ` +
          'Start it with: docker compose up -d --build verification-service',
      )
    }

    // Generate issuer and owner keypairs
    issuerKey = KeyPair.generate()
    ownerKey = KeyPair.generate()

    // Register the issuer as trusted
    const result = await addTrustedIssuer(issuerKey.publicKey().toHex(), 'E2E Test Issuer')
    expect(result.status).toBe(200)
    console.log('Registered issuer:', issuerKey.publicKey().toHex().slice(0, 16) + '...')
  })

  test('basic selective disclosure: issue → compact → verify via service', async () => {
    const challenge = `e2e-basic-${Date.now()}`

    // Issue a credential
    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      name: 'Alice Johnson',
      age: 25,
      email: 'alice@example.com',
      dateOfBirth: '1999-01-15',
      nationality: 'NL',
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const proofDoc = doc.issue(issuerKey)

    // Generate proof disclosing only name and age
    const request: ProofRequest = {
      disclose: ['name', 'age'],
      predicates: [],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge,
    }

    const token = proofDoc.prove(request, ownerKey, 3600)

    // Encode to compact format
    const compact = token.toCompact()
    console.log('Compact token size:', compact.length, 'chars')
    expect(compact.startsWith('OID1:')).toBe(true)

    // Verify via service
    const result = await verifyCompactToken(compact, challenge)
    console.log('Verify response:', JSON.stringify(result.body))

    expect(result.status).toBe(200)
    expect(result.body.valid).toBe(true)
    expect(result.body.subjects).toBeDefined()
    expect(result.body.subjects.name).toBe('Alice Johnson')
    expect(result.body.subjects.age).toBe(25)
    // SSN/email should NOT be disclosed
    expect(result.body.subjects.email).toBeUndefined()
  })

  test('ZK age range proof: prove age >= 18 without revealing age', async () => {
    const challenge = `e2e-age-${Date.now()}`

    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      name: 'Bob Smith',
      dateOfBirth: '2000-06-15',
      nationality: 'DE',
      verificationLevel: 'high',
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const proofDoc = doc.issue(issuerKey)

    const request: ProofRequest = {
      disclose: ['name'],
      predicates: [
        {
          attribute: 'dateOfBirth',
          op: 'GreaterOrEqual',
          value: '18', // age >= 18
        },
      ],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge,
    }

    const token = proofDoc.prove(request, ownerKey, 3600)
    const compact = token.toCompact()
    console.log('Compact token with ZK age proof:', compact.length, 'chars')

    const result = await verifyCompactToken(compact, challenge)
    console.log('Verify response:', JSON.stringify(result.body))

    expect(result.status).toBe(200)
    expect(result.body.valid).toBe(true)
    expect(result.body.subjects.name).toBe('Bob Smith')
    // dateOfBirth should NOT be in disclosed subjects
    expect(result.body.subjects.dateOfBirth).toBeUndefined()
  })

  test('ZK nationality proof: prove EU citizenship without revealing country', async () => {
    const challenge = `e2e-nat-${Date.now()}`

    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      name: 'Clara van Dijk',
      dateOfBirth: '1985-03-20',
      nationality: 'NL',
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const proofDoc = doc.issue(issuerKey)

    // Prove nationality is in EU set
    const euCountries = [
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
    ]

    const request: ProofRequest = {
      disclose: ['name'],
      predicates: [
        {
          attribute: 'nationality',
          op: 'InSet',
          value: JSON.stringify(euCountries),
        },
      ],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge,
    }

    const token = proofDoc.prove(request, ownerKey, 3600)
    const compact = token.toCompact()
    console.log('Compact token with ZK nationality proof:', compact.length, 'chars')

    const result = await verifyCompactToken(compact, challenge)
    console.log('Verify response:', JSON.stringify(result.body))

    expect(result.status).toBe(200)
    expect(result.body.valid).toBe(true)
    expect(result.body.subjects.name).toBe('Clara van Dijk')
    // nationality should NOT be disclosed
    expect(result.body.subjects.nationality).toBeUndefined()
  })

  test('ZK KYC status proof: prove verification level >= required', async () => {
    const challenge = `e2e-kyc-${Date.now()}`

    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      name: 'Diana Schmidt',
      dateOfBirth: '1990-11-05',
      verificationLevel: 'high',
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const proofDoc = doc.issue(issuerKey)

    const request: ProofRequest = {
      disclose: ['name'],
      predicates: [
        {
          attribute: 'verificationLevel',
          op: 'GreaterOrEqual',
          value: '2', // level >= 2 (substantial)
        },
      ],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge,
    }

    const token = proofDoc.prove(request, ownerKey, 3600)
    const compact = token.toCompact()
    console.log('Compact token with KYC proof:', compact.length, 'chars')

    const result = await verifyCompactToken(compact, challenge)
    console.log('Verify response:', JSON.stringify(result.body))

    expect(result.status).toBe(200)
    expect(result.body.valid).toBe(true)
    expect(result.body.subjects.name).toBe('Diana Schmidt')
    expect(result.body.subjects.verificationLevel).toBeUndefined()
  })

  test('multiple ZK proofs: age + nationality in one token', async () => {
    const challenge = `e2e-multi-zk-${Date.now()}`

    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      name: 'Erik Mueller',
      dateOfBirth: '1995-08-10',
      nationality: 'DE',
      verificationLevel: 'substantial',
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const proofDoc = doc.issue(issuerKey)

    const euCountries = [
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
    ]

    const request: ProofRequest = {
      disclose: ['name'],
      predicates: [
        {
          attribute: 'dateOfBirth',
          op: 'GreaterOrEqual',
          value: '21',
        },
        {
          attribute: 'nationality',
          op: 'InSet',
          value: JSON.stringify(euCountries),
        },
      ],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge,
    }

    const token = proofDoc.prove(request, ownerKey, 3600)
    const compact = token.toCompact()
    console.log('Compact token with 2 ZK proofs:', compact.length, 'chars')

    const result = await verifyCompactToken(compact, challenge)
    console.log('Verify response:', JSON.stringify(result.body))

    expect(result.status).toBe(200)
    expect(result.body.valid).toBe(true)
    expect(result.body.subjects.name).toBe('Erik Mueller')
    expect(result.body.subjects.dateOfBirth).toBeUndefined()
    expect(result.body.subjects.nationality).toBeUndefined()
  })

  test('wrong challenge rejected by service', async () => {
    const challenge = `e2e-wrong-challenge-${Date.now()}`

    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      name: 'Fiona Test',
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const proofDoc = doc.issue(issuerKey)

    const request: ProofRequest = {
      disclose: ['name'],
      predicates: [],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge,
    }

    const token = proofDoc.prove(request, ownerKey, 3600)
    const compact = token.toCompact()

    // Send with a different challenge
    const result = await verifyCompactToken(compact, 'wrong-challenge')

    expect(result.status).toBe(200)
    expect(result.body.valid).toBe(false)
    expect(result.body.error).toBeDefined()
    console.log('Correctly rejected wrong challenge:', result.body.error)
  })

  test('untrusted issuer rejected by service', async () => {
    const challenge = `e2e-untrusted-${Date.now()}`
    const untrustedIssuer = KeyPair.generate()

    const attributes = {
      issuerKey: untrustedIssuer.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      name: 'Untrusted Person',
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const proofDoc = doc.issue(untrustedIssuer)

    const request: ProofRequest = {
      disclose: ['name'],
      predicates: [],
      trustedIssuers: [untrustedIssuer.publicKey().toHex()],
      challenge,
    }

    const token = proofDoc.prove(request, ownerKey, 3600)
    const compact = token.toCompact()

    // The verification service only trusts issuers in its DB
    const result = await verifyCompactToken(compact, challenge)

    expect(result.status).toBe(200)
    expect(result.body.valid).toBe(false)
    expect(result.body.error).toBeDefined()
    console.log('Correctly rejected untrusted issuer:', result.body.error)
  })

  test('compact round-trip: to_compact → from_compact → verify locally', () => {
    const challenge = `e2e-roundtrip-${Date.now()}`

    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      name: 'Georg Test',
      age: 30,
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const proofDoc = doc.issue(issuerKey)

    const request: ProofRequest = {
      disclose: ['name', 'age'],
      predicates: [],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge,
    }

    const token = proofDoc.prove(request, ownerKey, 3600)

    // Round-trip through compact
    const compact = token.toCompact()
    const restored = Token.fromCompact(compact)

    // Verify the restored token locally
    const result = restored.verify([issuerKey.publicKey()], challenge)
    const parsed = JSON.parse(result)

    expect(parsed.name).toBe('Georg Test')
    expect(parsed.age).toBe(30)
    console.log('Compact round-trip verified locally')
  })

  test('compact vs JSON size comparison', () => {
    const challenge = `e2e-size-${Date.now()}`

    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      name: 'Size Test User',
      dateOfBirth: '1990-01-01',
      nationality: 'FR',
      verificationLevel: 'high',
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const proofDoc = doc.issue(issuerKey)

    const euCountries = [
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
    ]

    const request: ProofRequest = {
      disclose: ['name'],
      predicates: [
        {
          attribute: 'dateOfBirth',
          op: 'GreaterOrEqual',
          value: '18',
        },
        {
          attribute: 'nationality',
          op: 'InSet',
          value: JSON.stringify(euCountries),
        },
      ],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge,
    }

    const token = proofDoc.prove(request, ownerKey, 3600)

    const jsonSize = token.toJson().length
    const compactSize = token.toCompact().length
    const savings = ((1 - compactSize / jsonSize) * 100).toFixed(1)

    console.log(`JSON size:    ${jsonSize} chars`)
    console.log(`Compact size: ${compactSize} chars`)
    console.log(`Savings:      ${savings}%`)

    // Compact should be significantly smaller
    expect(compactSize).toBeLessThan(jsonSize)
    // At least 30% smaller
    expect(compactSize).toBeLessThan(jsonSize * 0.7)
    // Under QR code practical limit (2 ZK proofs is the heaviest case)
    expect(compactSize).toBeLessThan(3500)
  })

  test('ring signature: anonymous owner auth via service', async () => {
    const challenge = `e2e-ring-${Date.now()}`

    const decoy1 = KeyPair.generate()
    const decoy2 = KeyPair.generate()

    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      name: 'Anonymous Poster',
      age: 30,
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const proofDoc = doc.issue(issuerKey)

    const request: ProofRequest = {
      disclose: ['name', 'age'],
      predicates: [],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge,
    }

    // Prepare token (no owner signature yet)
    const prepared = proofDoc.prepare(request, 3600)

    // Finalize with ring signature: owner + 2 decoys
    const ring = [
      ownerKey.publicKey().toHex(),
      decoy1.publicKey().toHex(),
      decoy2.publicKey().toHex(),
    ]
    const token = Token.finalizeRingSig(prepared, ownerKey.toHex(), ring)

    const compact = token.toCompact()
    console.log('Ring sig compact size:', compact.length, 'chars')
    expect(compact.startsWith('OID1:')).toBe(true)

    const result = await verifyCompactToken(compact, challenge)
    console.log('Ring sig verify response:', JSON.stringify(result.body))

    expect(result.status).toBe(200)
    expect(result.body.valid).toBe(true)
    expect(result.body.subjects.name).toBe('Anonymous Poster')
    expect(result.body.subjects.age).toBe(30)
  })

  test('ring signature + ZK age proof: full anonymous flow', async () => {
    const challenge = `e2e-ring-zk-${Date.now()}`

    const decoy1 = KeyPair.generate()
    const decoy2 = KeyPair.generate()
    const decoy3 = KeyPair.generate()

    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      name: 'Forum User',
      dateOfBirth: '1998-04-22',
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const proofDoc = doc.issue(issuerKey)

    const request: ProofRequest = {
      disclose: [],
      predicates: [
        {
          attribute: 'dateOfBirth',
          op: 'GreaterOrEqual',
          value: '18',
        },
      ],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge,
    }

    const prepared = proofDoc.prepare(request, 3600)

    // 4-member ring
    const ring = [
      decoy1.publicKey().toHex(),
      ownerKey.publicKey().toHex(),
      decoy2.publicKey().toHex(),
      decoy3.publicKey().toHex(),
    ]
    const token = Token.finalizeRingSig(prepared, ownerKey.toHex(), ring)

    const compact = token.toCompact()
    console.log('Ring + ZK age compact size:', compact.length, 'chars')

    const result = await verifyCompactToken(compact, challenge)
    console.log('Ring + ZK verify response:', JSON.stringify(result.body))

    expect(result.status).toBe(200)
    expect(result.body.valid).toBe(true)
    // Name should NOT be disclosed (not in disclose list)
    expect(result.body.subjects.name).toBeUndefined()
    // dateOfBirth should NOT be disclosed (ZK predicate only)
    expect(result.body.subjects.dateOfBirth).toBeUndefined()
  })

  test('ring signature compact round-trip: encode → decode → verify locally', () => {
    const challenge = `e2e-ring-roundtrip-${Date.now()}`

    const decoy = KeyPair.generate()

    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      name: 'Roundtrip Ring User',
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const proofDoc = doc.issue(issuerKey)

    const request: ProofRequest = {
      disclose: ['name'],
      predicates: [],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge,
    }

    const prepared = proofDoc.prepare(request, 3600)
    const ring = [ownerKey.publicKey().toHex(), decoy.publicKey().toHex()]
    const token = Token.finalizeRingSig(prepared, ownerKey.toHex(), ring)

    // Round-trip through compact format
    const compact = token.toCompact()
    const restored = Token.fromCompact(compact)

    // Verify locally
    const result = restored.verify([issuerKey.publicKey()], challenge)
    const parsed = JSON.parse(result)

    expect(parsed.name).toBe('Roundtrip Ring User')
    console.log('Ring sig compact round-trip verified locally')
  })

  test('ring signature + nationality proof: anonymous EU citizen', async () => {
    const challenge = `e2e-ring-nat-${Date.now()}`

    const decoy1 = KeyPair.generate()
    const decoy2 = KeyPair.generate()

    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      name: 'Hidden EU Citizen',
      nationality: 'FR',
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const proofDoc = doc.issue(issuerKey)

    const euCountries = [
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
    ]

    const request: ProofRequest = {
      disclose: [],
      predicates: [
        {
          attribute: 'nationality',
          op: 'InSet',
          value: JSON.stringify(euCountries),
        },
      ],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge,
    }

    const prepared = proofDoc.prepare(request, 3600)
    const ring = [
      decoy1.publicKey().toHex(),
      ownerKey.publicKey().toHex(),
      decoy2.publicKey().toHex(),
    ]
    const token = Token.finalizeRingSig(prepared, ownerKey.toHex(), ring)

    const compact = token.toCompact()
    console.log('Ring + nationality compact size:', compact.length, 'chars')

    const result = await verifyCompactToken(compact, challenge)
    console.log('Ring + nationality verify response:', JSON.stringify(result.body))

    expect(result.status).toBe(200)
    expect(result.body.valid).toBe(true)
    // Nothing should be disclosed — fully anonymous
    expect(result.body.subjects.name).toBeUndefined()
    expect(result.body.subjects.nationality).toBeUndefined()
  })

  test('expired token rejected by service', async () => {
    const challenge = `e2e-expired-${Date.now()}`

    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      name: 'Expired User',
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const proofDoc = doc.issue(issuerKey)

    const request: ProofRequest = {
      disclose: ['name'],
      predicates: [],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge,
    }

    // Create token with 1-second TTL
    const token = proofDoc.prove(request, ownerKey, 1)
    const compact = token.toCompact()

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 2000))

    const result = await verifyCompactToken(compact, challenge)

    expect(result.status).toBe(200)
    expect(result.body.valid).toBe(false)
    expect(result.body.error).toBeDefined()
    console.log('Correctly rejected expired token:', result.body.error)
  })
})
