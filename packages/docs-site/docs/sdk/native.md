<!-- AUTO-GENERATED — do not edit. Source: docs/sdk/native.md -->

# Token primitives

Holder-side cryptographic primitives — `Credential`, `Token`, `KeyPair`, etc. Lives on the `@owlid/sdk/native` subpath. Implemented in Rust, compiled to native (Node) or WASM (browser) automatically. Importing this subpath is what loads the WASM module; if you only call REST endpoints, stay on the `@owlid/sdk` root and skip it.

See [bundler & WASM setup](../integration/bundler.md) for the Vite / Webpack / Next.js configuration the native subpath needs.

```ts
import { Credential, Token, KeyPair, PublicKey } from '@owlid/sdk/native'
```

These run entirely on the holder's device. Token generation never round-trips to the platform.

## Classes

### `KeyPair`

Ed25519 keypair for the holder.

```ts
const kp = KeyPair.generate()
const restored = KeyPair.fromHex(privateHex)

kp.publicKey() // → PublicKey
kp.toHex() // 64 hex chars (private seed)
kp.sign(messageBytes) // → Signature
```

### `PublicKey`

Ed25519 public key.

```ts
const pk = PublicKey.fromHex(hex)
pk.toHex() // 64 hex chars
pk.verify(messageBytes, sig) // boolean
```

### `Document`

Unsigned attribute container. Held by the issuer before signing.

```ts
const doc = Document.fromJson(jsonString)
const credential = doc.issue(issuerKeyPair)
```

### `Credential`

Signed credential — Merkle root + issuer signature + attributes. The output of issuance, what holders store.

```ts
const credential = Credential.fromJson(storedJson)

credential.rootHash() // 64 hex chars (Merkle root)
credential.toJson() // serialise

// One-phase signing (raw Ed25519 owner)
credential.prove(request, ownerKeyPair, ttlSeconds) // → Token

// Two-phase (WebAuthn / ring signature)
credential.prepare(request, ttlSeconds) // → PreparedToken
```

### `Token`

Verifiable proof token.

```ts
token.toCompact() // "OID1:..." — fits a QR code
Token.fromCompact(compact) // restore

token.subjects() // disclosed attributes (JSON string)
token.challenge() // bound challenge
token.rootHash() // credential root hash
token.ttl() // seconds
token.activationTime() // unix epoch seconds
token.zkProofCount() // number of ZK predicate proofs

// Holder-side verification (no platform round-trip)
token.verify([trustedIssuerPubKey], expectedChallenge, /* revokedRoots */ [])

// WebAuthn finalisation
Token.finalizeWebauthn(prepared, webauthnSig, credentialPublicKeyHex)

// Ring-signature finalisation (anonymous owner authentication)
Token.finalizeRingSig(prepared, privateKeyHex, ringPublicKeysHex)
```

### `PreparedToken`

Two-phase signing intermediate.

```ts
prepared.challenge() // base64url, pass to navigator.credentials.get()
prepared.payloadJson() // unsigned payload (debugging)
prepared.toJson() // serialise
```

## Proof requests

```ts
interface ProofRequest {
  /** Attributes to reveal as plaintext. */
  disclose: string[]
  /** Zero-knowledge predicates to attach. */
  predicates: PredicateRequest[]
  /** Hex public keys you trust to have issued the credential. */
  trustedIssuers: string[]
  /** Random challenge from the verifier. */
  challenge: string
}

interface PredicateRequest {
  attribute: string
  /** 'GreaterOrEqual' (e.g. age ≥ 18) or 'InSet' (e.g. nationality ∈ EU). */
  op: 'GreaterOrEqual' | 'InSet'
  /**
   * Wire value, JSON-encoded.
   *  - `GreaterOrEqual`: a number (e.g. `'18'`).
   *  - `InSet`: a registered dataset name string (e.g. `'"eu"'`).
   *
   * For `InSet`, the holder ships only the dataset name — the verifier
   * recomputes the canonical Merkle root from that name and pins the proof's
   * public input against it.
   */
  value: string
}
```

## Hash helpers

```ts
import { blake3, sha256 } from '@owlid/sdk/native'

blake3(buffer) // 64 hex chars
sha256(buffer) // 64 hex chars
```

## Compact format

Tokens encode through `JSON → CBOR → zstd → Base45 → "OID1:" prefix`. Typical size 500–1500 bytes — fits a QR code (Version 25–40 at error correction Q).

## Groth16 proving keys

ZK predicates are proved with Groth16 over BLS12-381. There are three circuits:

| Circuit       | Used for                                            |
| ------------- | --------------------------------------------------- |
| `age_range`   | `dateOfBirth` `GreaterOrEqual` (e.g. `age ≥ 18`)    |
| `kyc_status`  | `verificationLevel` / `isResident` `GreaterOrEqual` |
| `nationality` | `nationality` `InSet` (Pedersen Merkle membership)  |

Each circuit needs a proving key (~150 KB–350 KB). Two delivery shapes:

- **Native (Node) builds**: keys are baked into the addon. No setup needed.
- **Browser/WASM builds**: keys are not bundled (would inflate the WASM blob). The SDK fetches them lazily on first proof from the verification service, caches in IndexedDB, and reuses across sessions.

Holder helpers (`signToken`, `signTokenWithPasskey`, `respondToPresentation`) load the right keys automatically — apps don't need to call anything. The default fetch URL is `${getVerificationUrl()}/zk-keys/<circuit>.pk.bin` — same trusted origin you already verify against, with `Cache-Control: public, immutable`.

### Override key delivery

Apps that want to bundle their own keys, host them on a CDN, or use a custom transport call `configureProvingKeys` once at startup:

```ts
import { configureProvingKeys } from '@owlid/sdk/native'

// Bundle bytes (e.g. via Vite ?url import)
import ageRangeUrl from './zk/age_range.pk.bin?url'
configureProvingKeys({
  bytes: { age_range: new Uint8Array(await (await fetch(ageRangeUrl)).arrayBuffer()) },
})

// Fetch from custom origin
configureProvingKeys({ baseUrl: 'https://cdn.mine.com/zk' })

// Fully custom loader
configureProvingKeys({
  loader: async (circuit) => {
    const r = await fetch(`/my/keys/${circuit}.bin`)
    return new Uint8Array(await r.arrayBuffer())
  },
})

// Disable IndexedDB cache (e.g. tests)
configureProvingKeys({ cache: false })
```

Sources resolve in priority order: `bytes` ▶ in-memory cache ▶ IndexedDB ▶ `loader` (or default fetch). The native build always reports `provingKeysRequired() === false` and skips the loader entirely.

### Eager prefetch

To warm the cache at app startup (e.g. during the splash screen) so the first proof has zero latency:

```ts
import { ensureProvingKeys, ensureProvingKeysFor } from '@owlid/sdk/native'

await ensureProvingKeys() // load all three (~660 KB total)
// or
await ensureProvingKeysFor(['age_range']) // just the one
```

Both are no-ops on native and idempotent on WASM.

### Trusted setup

The keys committed in `crates/zk-circuits/artifacts/` come from `keygen` with **fixed deterministic seeds**. Production deployment must replace them with the output of a Phase-2 MPC ceremony — see [`crates/zk-circuits/CEREMONY.md`](../../crates/zk-circuits/CEREMONY.md). The artifact format and the `/zk-keys/<circuit>.pk.bin` URL do not change; only the bytes do.
