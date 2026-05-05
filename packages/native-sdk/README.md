# owl-id

Privacy-preserving identity SDK for Node.js and browsers using napi-rs.

## Features

- **Native Performance**: 10-100x faster than WASM in Node.js
- **Cross-Platform**: Works on macOS, Linux, Windows (x86_64 and ARM64)
- **TypeScript Support**: Auto-generated type definitions
- **Zero-Knowledge Proofs**: Selective disclosure using Merkle proofs
- **Ed25519 Signatures**: Fast and secure cryptographic signatures
- **No Dependencies**: Self-contained native addon

## Installation

```bash
npm install owl-id
```

## Usage

```typescript
import { KeyPair, Document, InfoRequest } from 'owl-id'

// Generate a keypair
const issuerKey = KeyPair.generate()
const ownerKey = KeyPair.generate()

// Create and issue a document
const doc = Document.new(
  JSON.stringify({
    issuerKey: issuerKey.publicKey().toHex(),
    ownerKey: ownerKey.publicKey().toHex(),
    name: 'Alice',
    age: 25,
    email: 'alice@example.com',
  }),
)

const proofDoc = doc.issue(issuerKey)
console.log('Root hash:', proofDoc.rootHash())

// Create a token with selective disclosure
const infoRequest: InfoRequest = {
  mandatory: ['age'], // Only disclose age, not name or email
  optional: [],
  trustedIssuers: [issuerKey.publicKey().toHex()],
  challenge: 'random-challenge-123',
}

const token = proofDoc.createToken(ownerKey, infoRequest, 3600)

// Verify the token
const result = token.verify([issuerKey.publicKey()], 'random-challenge-123')
console.log('Disclosed attributes:', JSON.parse(result))
```

## API

### KeyPair

- `KeyPair.generate()` - Generate new Ed25519 keypair
- `KeyPair.fromHex(hex)` - Load keypair from hex
- `publicKey()` - Get public key
- `privateKeyHex()` - Export private key as hex
- `sign(message)` - Sign a message

### Document

- `Document.new(attributesJson)` - Create document from JSON
- `issue(issuerKeypair)` - Issue and sign document

### ProofDocument

- `createToken(ownerKeypair, infoRequest, ttlSeconds)` - Create token
- `rootHash()` - Get Merkle root hash
- `toJson()` / `fromJson()` - Serialize/deserialize

### Token

- `verify(trustedIssuers, challenge)` - Verify token
- `toJson()` / `fromJson()` - Serialize/deserialize

## Architecture

owl-id wraps the existing OwlID Rust crates with napi-rs bindings:

- `owl-crypto` - Cryptographic primitives (Ed25519, SHA-256, Merkle trees)
- `owl-proof-system` - Zero-knowledge proof system

This ensures no code duplication and maintains compatibility with the backend services.

## License

MIT OR Apache-2.0
