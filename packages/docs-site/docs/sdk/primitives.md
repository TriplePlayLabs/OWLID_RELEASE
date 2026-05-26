# SD-JWT VC primitives

Low-level building blocks exported from `@owlid/sdk`. Most apps use [`OwlVerifier`](/sdk/verifier), [`OwlIssuer`](/sdk/issuer), or [`OwlWallet`](/integration/holder) instead — reach for these primitives only when you need direct control over key material or the SD-JWT VC wire format.

All of it is pure TypeScript (`@noble/ed25519` + `@noble/hashes`) — no WASM, no native binaries. Output is standard SD-JWT VC, accepted by any conformant verifier.

```ts
import { KeyPair, PublicKey, SdJwtVc, presentSdJwtVc, verifySdJwt } from '@owlid/sdk'
```

## `KeyPair`

A holder signing key (Ed25519). The wallet keeps the 32-byte seed PRF-wrapped by the passkey — see [Holder integration](/integration/holder).

```ts
const key = KeyPair.generate() // fresh random key
const same = KeyPair.fromHex(seedHex) // restore from a stored seed

key.toHex() // 32-byte private seed, hex — persist this (wrapped)
key.publicKeyHex() // public key, hex — goes in the credential `cnf`
```

| Member               | Returns   | Notes                                        |
| -------------------- | --------- | -------------------------------------------- |
| `KeyPair.generate()` | `KeyPair` | New random Ed25519 key.                      |
| `KeyPair.fromHex(h)` | `KeyPair` | Restore from a 32-byte seed hex.             |
| `.toHex()`           | `string`  | Private seed hex. Store wrapped, never bare. |
| `.publicKeyHex()`    | `string`  | Public key hex.                              |

## `PublicKey`

```ts
const pk = PublicKey.fromHex(hex)
pk.toHex() // hex string
```

## `SdJwtVc`

Parsed view of an SD-JWT VC string (`<JWT>~<disclosure>~…~<KB-JWT>`).

```ts
const vc = SdJwtVc.parse(storedCredential.sdJwtVc)

vc.peekIssuer() // `iss` claim — did:web identifier
vc.credentialId() // stable id (base64url) used for revocation lookups
vc.disclosedClaimNames() // names of the disclosures present on this string
vc.disclosedClaim('given_name') // a single disclosed value
vc.serialize() // back to the wire string
```

To build a presentation from a parsed credential, use `presentSdJwtVc` (below).

## `presentSdJwtVc(sdJwtVc, holderKeyHex, disclose, binding)`

The per-credential presentation primitive: select disclosures and bind them to the verifier with a key-binding JWT. Synchronous — returns the presentation string.

```ts
const presentation = presentSdJwtVc(
  storedCredential.sdJwtVc, // the issued SD-JWT VC string
  holderKeyHex, // seed hex from unwrapHolderKey()
  ['given_name', 'age_over_18'], // claims to disclose
  { aud: verifierOrigin, nonce: verifierNonce }, // bound into the KB-JWT
)
```

| Parameter      | Type                                           | Notes                                  |
| -------------- | ---------------------------------------------- | -------------------------------------- |
| `sdJwtVc`      | `string`                                       | The issued SD-JWT VC.                  |
| `holderKeyHex` | `string`                                       | Holder seed hex (`KeyPair.toHex()`).   |
| `disclose`     | `string[]`                                     | Claim names to reveal.                 |
| `binding`      | `{ aud: string; nonce: string; iat?: number }` | KB-JWT binding. `iat` defaults to now. |

For multi-credential `vp_token` assembly (OpenID4VP DCQL), use [`OwlWallet`](/integration/holder) instead.

## `verifySdJwt(presentation, issuerPublicKeyHex, requireKb, audience?, nonce?)`

Offline verification of a presentation against a known issuer key. The hosted [`OwlVerifier.verify()`](/sdk/verifier) does this plus did:web resolution and revocation checks — use `verifySdJwt` only for offline / self-contained checks where you already trust the issuer key.

```ts
const result = verifySdJwt(presentation, issuerPublicKeyHex, true, verifierOrigin, nonce)
if (result.valid) {
  const claims = JSON.parse(result.claims ?? '{}') // claims is a stringified JSON object
  console.log(claims)
}
```

| Parameter            | Type      | Notes                                                 |
| -------------------- | --------- | ----------------------------------------------------- |
| `presentation`       | `string`  | The SD-JWT VC presentation string.                    |
| `issuerPublicKeyHex` | `string`  | Trusted issuer public key.                            |
| `requireKb`          | `boolean` | Require a key-binding JWT (`true` for presentations). |
| `audience`           | `string?` | Expected KB-JWT `aud`.                                |
| `nonce`              | `string?` | Expected KB-JWT `nonce`.                              |
