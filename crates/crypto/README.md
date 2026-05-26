# owl-crypto

Cryptographic primitives shared across the OwlID workspace.

## Modules

| Module       | Surface                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `signature`  | `KeyPair`, `PublicKey`, `Signature`, `SignatureAlgorithm` — Ed25519 and P-256                  |
| `hash`       | `HashAlgorithm`, `hash_attribute`, `hash_attribute_salted`, `generate_salt` — BLAKE3 + SHA-256 |
| `webauthn`   | `CoseKey`, `WebAuthnSignature`, `WebAuthnError` — COSE key parsing, P-256 verification         |
| `encryption` | `encrypt`, `decrypt`, `key_from_hex`, `EncryptionError` — AES-256-GCM at-rest                  |
| `ring_sig`   | `RingSignature`, `RingSignatureError` — anonymous group signatures (Schnorr ring)              |

`MerkleTree` / `MerkleProof` were removed when OwlID moved to SD-JWT VC as its single credential format. SD-JWT VC selective disclosure relies on per-claim salt + SHA-256 hashes in the issuer-signed `_sd` array, not a Merkle tree.

## Usage

```rust
use owl_crypto::{KeyPair, hash_attribute_salted, generate_salt};

// Generate a keypair (Ed25519 by default).
let kp = KeyPair::generate();

// Sign + verify.
let msg = b"hello";
let sig = kp.sign(msg);
assert!(sig.verify(&kp.public_key(), msg).is_ok());

// Salted hashes for SD-JWT VC `_sd` array.
let salt = generate_salt();
let hashed = hash_attribute_salted("name=Alice", &salt);
```

## Public-key formats

- **Ed25519**: 32-byte raw public key, 32-byte private key. Hex strings of length 64.
- **P-256**: SEC1-encoded public key. Compressed (33 bytes / 66 hex chars) or uncompressed (65 bytes / 130 hex chars). Used for WebAuthn passkeys + ES256 holder confirmation keys.

`PublicKey::from_hex` auto-detects by length. `PublicKey::from_hex_with_algorithm` is explicit and recommended whenever the algorithm is known up front.

## Algorithm guarantees

- **Hashing** defaults to BLAKE3 for general digests and SHA-256 for protocol-level digests (SD-JWT VC `_sd` array, challenge binding, key hashing, COSE).
- **Salting**: every SD-JWT VC disclosure carries its own random salt, mixed into the `_sd` hash. Prevents rainbow tables across credentials and unlinks the same claim across verifications.
- **WebAuthn**: ES256 / COSE alg `-7`, P-256 over secp256r1, SHA-256.

## Tests

```bash
cargo test -p owl-crypto
```
