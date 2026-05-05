# @owlid/native-sdk

Cryptographic primitives for OwlID — Rust core compiled to native (NAPI-RS) for Node.js and to WASM for browsers.

Most apps consume this through `@owlid/sdk` which re-exports the same surface from `@owlid/sdk` and `@owlid/sdk/native`. Install this package directly only when you need it without the rest of the SDK.

```bash
bun add @owlid/native-sdk
```

## Platform support

NAPI prebuilds (auto-selected via optional dependencies):

| Family   | Targets                                                  |
| -------- | -------------------------------------------------------- |
| Linux    | x64 (gnu/musl), arm64 (gnu/musl), armv7 gnueabihf        |
| macOS    | x64 (Intel), arm64 (Apple Silicon)                       |
| Windows  | x64, arm64, i686                                         |
| Android  | arm64, arm                                               |
| FreeBSD  | x64                                                      |
| Browsers | `wasm32-wasip1-threads` (loaded via `wasm-runtime` shim) |

Node.js ≥ 18 required for native; bundlers must support top-level await + WebAssembly for the browser build (`vite-plugin-wasm` + `vite-plugin-top-level-await` recommended).

## Public surface

All classes/functions are typed via the auto-generated `index.d.ts`. JSDoc on every method.

### Classes

| Symbol          | Purpose                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| `KeyPair`       | Ed25519 keypair — `generate`, `fromHex`, `sign`, `publicKey`             |
| `PublicKey`     | Ed25519 public key — `fromHex`, `toHex`, `verify`                        |
| `Signature`     | Ed25519 signature wrapper — `fromHex`, `toHex`                           |
| `Document`      | Unsigned attribute container — `fromJson`, `issue(issuerKeypair)`        |
| `Credential`    | Signed credential — `prove`, `prepare`, `rootHash`, `toJson`, `fromJson` |
| `Token`         | Verifiable proof token — `toCompact`, `fromCompact`, `verify`, …         |
| `PreparedToken` | Two-phase signing intermediate (WebAuthn / ring sig)                     |

### Free functions

- `blake3(data: Buffer): string` — 256-bit BLAKE3 hex digest
- `sha256(data: Buffer): string` — 256-bit SHA-256 hex digest

### Types

- `ProofRequest` — `{ disclose, predicates, trustedIssuers, challenge }`
- `PredicateRequest` — `{ attribute, op, value }` where `op ∈ "GreaterOrEqual" | "InSet"`
- `WebAuthnSignatureData` — `{ authenticatorData, clientDataJson, signature }` (base64)

## Usage

### Issue a credential

```ts
import { Document, KeyPair } from '@owlid/native-sdk'

const issuer = KeyPair.generate()
const owner = KeyPair.generate()

const doc = Document.fromJson(
  JSON.stringify({
    issuerKey: issuer.publicKey().toHex(),
    ownerKey: owner.publicKey().toHex(),
    firstName: 'Alice',
    dateOfBirth: '1990-05-15',
    nationality: 'NL',
  }),
)

const credential = doc.issue(issuer)
const stored = credential.toJson()
```

### Generate a token (one-phase, raw Ed25519 signing)

```ts
import { Credential } from '@owlid/native-sdk'

const credential = Credential.fromJson(stored)

const token = credential.prove(
  {
    disclose: ['firstName'],
    predicates: [{ attribute: 'dateOfBirth', op: 'GreaterOrEqual', value: '18' }],
    trustedIssuers: [issuerPublicKeyHex],
    challenge: verifierChallenge,
  },
  owner,
  /* ttlSeconds */ 300,
)

const compact = token.toCompact() // "OID1:..." — fits a QR
```

### Generate a token (two-phase, WebAuthn signing)

```ts
import { Credential, Token } from '@owlid/native-sdk'

// Phase 1 — prepare
const prepared = credential.prepare(proofRequest, /* ttlSeconds */ 300)
const challenge = prepared.challenge()    // pass to navigator.credentials.get()

// Phase 2 — let the secure enclave sign
const assertion = await navigator.credentials.get({
  publicKey: { challenge: base64urlToBuffer(challenge), allowCredentials: [...] },
})

// Phase 3 — finalize
const token = Token.finalizeWebauthn(prepared, {
  authenticatorData: bufferToBase64(assertion.response.authenticatorData),
  clientDataJson:    bufferToBase64(assertion.response.clientDataJSON),
  signature:         bufferToBase64(assertion.response.signature),
}, credentialPublicKeyHex)
```

The private key never leaves the authenticator.

### Verify a token

```ts
import { Token, PublicKey } from '@owlid/native-sdk'

const token = Token.fromCompact(compact)
const issuerPk = PublicKey.fromHex(issuerHex)

const json = token.verify([issuerPk], expectedChallenge, /* revokedRoots */ [])
const disclosed = JSON.parse(json)
```

`verify` checks: Merkle proof validity, ZK predicate proofs, signature, expiry, issuer trust, revocation. Throws on any failure.

## Compact format

Tokens encode through `JSON → CBOR → zstd(dict) → Base45 → "OID1:" prefix`. Typical size 500–1500 bytes — fits a QR code (Version 25–40 at error correction Q).

## Building from source

```bash
just build-sdk            # builds native + WASM + TS facade
```

Or direct napi-rs:

```bash
bun install
napi build --platform --release
```

Tests:

```bash
cd packages/native-sdk && bun test
```

## License

MIT.
