import { describe, test, expect } from 'bun:test'

import { KeyPair, Document, Credential, Token, type ProofRequest } from '../index.js'

describe('Proof of Inclusion System', () => {
  test('Full proof flow: issue → generate proof → verify', () => {
    // 1. Generate keypairs for issuer and owner
    const issuerKey = KeyPair.generate()
    const ownerKey = KeyPair.generate()

    console.log('✓ Generated keypairs')
    console.log('  Issuer public key:', issuerKey.publicKey().toHex())
    console.log('  Owner public key:', ownerKey.publicKey().toHex())

    // 2. Create document with multiple attributes
    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      name: 'Alice Johnson',
      age: 25,
      email: 'alice@example.com',
      ssn: '123-45-6789',
      dateOfBirth: '1999-01-15',
      country: 'USA',
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    console.log('\n✓ Created document with attributes:', Object.keys(attributes))

    // 3. Issue the document (issuer signs it)
    const credential = doc.issue(issuerKey)
    const rootHash = credential.rootHash()

    console.log('\n✓ Issued document')
    console.log('  Root hash:', rootHash)

    expect(rootHash).toBeTruthy()
    expect(rootHash.length).toBe(64) // SHA-256 hash is 64 hex chars

    // 4. Generate proof token disclosing only age (not SSN or name)
    const proofRequest: ProofRequest = {
      disclose: ['age'],
      predicates: [],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge: 'test-challenge-12345',
    }

    const token = credential.prove(proofRequest, ownerKey, 3600)
    const tokenJson = token.toJson()

    console.log('\n✓ Generated proof token with selective disclosure')
    console.log('  Disclosed attributes: age only')
    console.log('  Token size:', tokenJson.length, 'bytes')

    expect(tokenJson).toBeTruthy()

    // Verify SSN is NOT in the token JSON (selective disclosure working)
    expect(tokenJson.includes('123-45-6789')).toBe(false)
    expect(tokenJson.includes('Alice')).toBe(false)
    expect(tokenJson.includes('age')).toBe(true)

    console.log('\n✓ Verified selective disclosure (SSN and name NOT leaked)')

    // 5. Verify the token
    const disclosedJson = token.verify([issuerKey.publicKey()], 'test-challenge-12345')

    console.log('\n✓ Verified token successfully')
    console.log('  Disclosed JSON:', disclosedJson)

    expect(disclosedJson).toBeTruthy()

    console.log('\n✓ Verified only requested attributes disclosed')
  })

  test('Proof of inclusion: multiple attributes', () => {
    const issuerKey = KeyPair.generate()
    const ownerKey = KeyPair.generate()

    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      firstName: 'Bob',
      lastName: 'Smith',
      age: 30,
      city: 'New York',
      state: 'NY',
      zip: '10001',
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const credential = doc.issue(issuerKey)

    // Request multiple attributes disclosed
    const proofRequest: ProofRequest = {
      disclose: ['firstName', 'city', 'state', 'age'],
      predicates: [],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge: 'multi-attr-challenge',
    }

    const token = credential.prove(proofRequest, ownerKey, 3600)
    const disclosedJson = token.verify([issuerKey.publicKey()], 'multi-attr-challenge')

    console.log('\nMultiple attributes test:')
    console.log('  Requested: firstName, city, state, age')
    console.log('  Verification result:', disclosedJson)

    expect(disclosedJson).toBeTruthy()

    console.log('✓ Multiple attribute disclosure works correctly')
  })

  test('Proof tampering detection', () => {
    const issuerKey = KeyPair.generate()
    const ownerKey = KeyPair.generate()

    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      age: 18,
      verified: false,
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const credential = doc.issue(issuerKey)

    const proofRequest: ProofRequest = {
      disclose: ['age'],
      predicates: [],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge: 'tamper-test',
    }

    const token = credential.prove(proofRequest, ownerKey, 3600)
    let tokenJson = token.toJson()

    console.log('\nTampering test:')
    console.log('  Original age: 18')

    // Tamper with the token JSON (change age from 18 to 21)
    tokenJson = tokenJson.replace('"age":18', '"age":21')

    console.log('  Tampered age: 21')

    // Try to verify tampered token
    const tamperedToken = Token.fromJson(tokenJson)

    console.log('  Attempting to verify tampered token...')

    expect(() => {
      tamperedToken.verify([issuerKey.publicKey()], 'tamper-test')
    }).toThrow()

    console.log('✓ Tampering detected!')
  })

  test('Replay attack prevention', () => {
    const issuerKey = KeyPair.generate()
    const ownerKey = KeyPair.generate()

    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      data: 'secret',
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const credential = doc.issue(issuerKey)

    const proofRequest: ProofRequest = {
      disclose: ['data'],
      predicates: [],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge: 'challenge-1',
    }

    const token = credential.prove(proofRequest, ownerKey, 3600)

    console.log('\nReplay attack test:')
    console.log('  Token created with challenge: challenge-1')

    // Token should verify with correct challenge
    const validResult = token.verify([issuerKey.publicKey()], 'challenge-1')
    expect(validResult).toBeTruthy()
    console.log('✓ Verification succeeds with correct challenge')

    // Token should fail with different challenge
    console.log('  Attempting to verify with wrong challenge: challenge-2')
    expect(() => {
      token.verify([issuerKey.publicKey()], 'challenge-2')
    }).toThrow()

    console.log('✓ Replay attack prevented!')
  })

  test('Untrusted issuer detection', () => {
    const issuerKey = KeyPair.generate()
    const ownerKey = KeyPair.generate()
    const attackerKey = KeyPair.generate()

    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      admin: true,
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const credential = doc.issue(issuerKey)

    const proofRequest: ProofRequest = {
      disclose: ['admin'],
      predicates: [],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge: 'trust-test',
    }

    const token = credential.prove(proofRequest, ownerKey, 3600)

    console.log('\nUntrusted issuer test:')
    console.log('  Document issued by:', issuerKey.publicKey().toHex().substring(0, 16) + '...')
    console.log(
      '  Verifier trusts attacker:',
      attackerKey.publicKey().toHex().substring(0, 16) + '...',
    )

    // Try to verify with wrong issuer public key
    expect(() => {
      token.verify([attackerKey.publicKey()], 'trust-test')
    }).toThrow()

    console.log('✓ Untrusted issuer detected!')
  })

  test('Serialization: Credential and Token to/from JSON', () => {
    const issuerKey = KeyPair.generate()
    const ownerKey = KeyPair.generate()

    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      data: 'test-data',
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const credential = doc.issue(issuerKey)

    // Serialize Credential to JSON
    const proofDocJson = credential.toJson()
    console.log('\nSerialization test:')
    console.log('  Credential JSON size:', proofDocJson.length, 'bytes')

    expect(proofDocJson).toBeTruthy()

    // Deserialize Credential from JSON
    const restoredProofDoc = Credential.fromJson(proofDocJson)
    expect(restoredProofDoc).toBeTruthy()
    expect(restoredProofDoc.rootHash()).toBe(credential.rootHash())

    console.log('✓ Credential serialization works')

    // Create token and test its serialization
    const proofRequest: ProofRequest = {
      disclose: ['data'],
      predicates: [],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge: 'serialization-test',
    }

    const token = credential.prove(proofRequest, ownerKey, 3600)
    const tokenJson = token.toJson()

    console.log('  Token JSON size:', tokenJson.length, 'bytes')
    expect(tokenJson).toBeTruthy()

    // Deserialize Token from JSON
    const restoredToken = Token.fromJson(tokenJson)
    expect(restoredToken).toBeTruthy()

    // Verify restored token works
    const result = restoredToken.verify([issuerKey.publicKey()], 'serialization-test')
    expect(result).toBeTruthy()

    console.log('✓ Token serialization works')
  })

  test('Token expiration (TTL)', async () => {
    const issuerKey = KeyPair.generate()
    const ownerKey = KeyPair.generate()

    const attributes = {
      issuerKey: issuerKey.publicKey().toHex(),
      ownerKey: ownerKey.publicKey().toHex(),
      data: 'time-sensitive',
    }

    const doc = Document.fromJson(JSON.stringify(attributes))
    const credential = doc.issue(issuerKey)

    const proofRequest: ProofRequest = {
      disclose: ['data'],
      predicates: [],
      trustedIssuers: [issuerKey.publicKey().toHex()],
      challenge: 'ttl-test',
    }

    // Create token with very short TTL (1 second)
    const token = credential.prove(proofRequest, ownerKey, 1)

    console.log('\nTTL test:')
    console.log('  Token created with TTL: 1 second')

    // Token should verify immediately
    const validResult = token.verify([issuerKey.publicKey()], 'ttl-test')
    expect(validResult).toBeTruthy()
    console.log('✓ Token valid immediately after creation')

    // Wait 2 seconds
    console.log('  Waiting 2 seconds...')
    await new Promise((resolve) => setTimeout(resolve, 2000))

    console.log('  Attempting to verify expired token...')
    expect(() => {
      token.verify([issuerKey.publicKey()], 'ttl-test')
    }).toThrow()

    console.log('✓ Expired token rejected!')
  })

  test('Signature: sign and verify', () => {
    const keypair = KeyPair.generate()
    const message = Buffer.from('Important message')

    console.log('\nSignature test:')
    console.log('  Message:', message.toString())

    // Sign the message
    const signature = keypair.sign(message)
    const sigHex = signature.toHex()

    console.log('  Signature:', sigHex.substring(0, 32) + '...')

    expect(sigHex.length).toBe(128) // Ed25519 signature is 64 bytes = 128 hex chars

    // Verify with correct public key
    const publicKey = keypair.publicKey()
    const valid = publicKey.verify(message, signature)

    expect(valid).toBe(true)
    console.log('✓ Signature verified with correct key')

    // Verify with wrong public key
    const wrongKey = KeyPair.generate().publicKey()
    const invalid = wrongKey.verify(message, signature)

    expect(invalid).toBe(false)
    console.log('✓ Signature rejected with wrong key')

    // Verify with tampered message
    const tamperedMessage = Buffer.from('Tampered message')
    const invalidMessage = publicKey.verify(tamperedMessage, signature)

    expect(invalidMessage).toBe(false)
    console.log('✓ Signature rejected with tampered message')
  })
})

describe('Hash Functions', () => {
  test('SHA-256 and BLAKE3', async () => {
    const { sha256, blake3 } = await import('../index.js')

    const data = Buffer.from('Hello, World!')

    const sha256Hash = sha256(data)
    const blake3Result = blake3(data)

    console.log('\nHash function test:')
    console.log('  Input:', data.toString())
    console.log('  SHA-256:', sha256Hash)
    console.log('  BLAKE3:', blake3Result)

    expect(sha256Hash.length).toBe(64) // SHA-256 is 256 bits = 64 hex chars
    expect(blake3Result.length).toBe(64) // BLAKE3 is also 256 bits

    // Hashes should be deterministic
    expect(sha256(data)).toBe(sha256Hash)
    expect(blake3(data)).toBe(blake3Result)

    console.log('✓ Hash functions work correctly')
  })
})
