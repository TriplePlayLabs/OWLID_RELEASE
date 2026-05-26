# @owlid/sdk

TypeScript SDK for OwlID — standards-conformant SD-JWT VC + OpenID4VCI/OpenID4VP holder, verifier, and issuer helpers in pure TypeScript.

```bash
bun add @owlid/sdk
```

Browser + Node. No platform binaries, no WASM plumbing. SD-JWT VC bytes match the Rust `owl_proof_system::sd_jwt` implementation, so any OwlID verifier accepts presentations minted here unchanged.

## Quick start

```ts
import { configure } from '@owlid/sdk'

configure({
  verificationUrl: 'https://verify.example.com',
  issuerUrl: 'https://issuer.example.com',
  apiKey: process.env.OWLID_API_KEY,
})
```

Call once at app boot. Every API singleton reads from this state. Browsers can also set `window.__OWLID_CONFIG__` for runtime config without rebuilds.

## Subpath exports

| Import                | Contents                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@owlid/sdk`          | `OwlVerifier`, `OwlIssuer`, holder helpers, WebAuthn, storage, encoding, presentation, SD-JWT VC primitives |
| `@owlid/sdk/verifier` | Re-exports `@owlid/verifier-client` (verification HTTP API singletons)                                      |
| `@owlid/sdk/issuer`   | Re-exports `@owlid/issuer-client` (issuer HTTP API singletons)                                              |

## Verifier integration

```ts
import { OwlVerifier } from '@owlid/sdk'

const verifier = new OwlVerifier({ apiKey: process.env.OWLID_API_KEY })

// 1. Direct verification of an SD-JWT VC presentation.
const challenge = await verifier.mintChallenge()
const result = await verifier.verify(presentation, challenge.challenge)
if (result.valid) console.log(result.subjects)

// 2. QR / WebSocket presentation session.
const session = await verifier.createPresentationSession()
// session.qrPayload → render as QR; session.verifierWsUrl is the
// fully-resolved WS URL the verifier side connects to.
```

## Issuer integration

```ts
import { OwlIssuer } from '@owlid/sdk'

const issuer = new OwlIssuer({ baseUrl: 'https://issuer.example.com' })

const session = await issuer.createSession({ providerId: 'mock-digid' })

// After the holder completes the provider flow, the issuer service
// signs an SD-JWT VC bound to the holder's confirmation key.
const credential = await issuer.issue(session.sessionId, {
  ownerPublicKey,
  keyAlgorithm: 'ed25519', // or 'p256'
})
// credential.sdJwtVc → application/dc+sd-jwt string
```

`OwlIssuer.issueBatch(n)` returns `n` one-time-use SD-JWT VCs (each with a distinct `credential_id` and independent revocation), used to defeat multi-show linkability.

## Holder — SD-JWT VC primitives

Pure TS, browser + Node. Built on `@noble/ed25519` + `@noble/hashes`.

```ts
import { KeyPair, SdJwtVc, verifySdJwt, presentSdJwtVc } from '@owlid/sdk'

const holder = await KeyPair.generate('ed25519')

// Parse an SD-JWT VC received from an issuer.
const credential = SdJwtVc.parse(sdJwtVcString)

// Build a presentation that discloses specific claims plus a KB-JWT
// bound to the verifier's nonce + audience.
const presentation = await presentSdJwtVc({
  credential,
  disclose: ['given_name', 'age_over_18'],
  holderKey: holder,
  audience: verifierOrigin,
  nonce: verifierNonce,
})

// Verifier side (server or other tab):
const result = await verifySdJwt(presentation, {
  audience: verifierOrigin,
  nonce: verifierNonce,
})
// → { valid, claims }
```

## WebAuthn / passkeys

WebAuthn is the **unlock and user-verification gate** for the holder key — never the signer. The KB-JWT is a standard JWS (EdDSA or ES256) over a wallet-held key.

```ts
import {
  registerCredential,
  authenticate,
  isWebAuthnSupported,
  wrapHolderKey,
  unwrapHolderKey,
} from '@owlid/sdk'

if (!isWebAuthnSupported()) throw new Error('WebAuthn not available')

const cred = await registerCredential({
  rpName: 'My Wallet',
  rpId: 'wallet.example.com',
  userName: user.email,
  userVerification: 'required',
})

// Wrap the holder's signing key with PRF output from the passkey.
const wrapped = await wrapHolderKey({ holderKey, credentialId: cred.credentialId })

// On unlock:
await authenticate({ credentialId: cred.credentialId, userVerification: 'required' })
const holderKey = await unwrapHolderKey({ wrapped, credentialId: cred.credentialId })
```

## Credential storage

```ts
import { storage, proofStorage, CredentialStorageManager } from '@owlid/sdk'

// Default: browserStorageAdapter — IndexedDB-backed in browsers.
await storage.saveCredential({ sdJwtVc, issuer, credentialId })
await storage.saveHolderKey(holderKeyMaterial)
const list = await storage.listCredentials()

// IndexedDB-backed proof history (verifier-bound presentations).
await proofStorage.put({ id, presentation, createdAt })
```

`storage` and `proofStorage` are singletons. For custom backends (mobile, server-side test rigs), instantiate `CredentialStorageManager` directly with your own `StorageAdapter`.

## Presentation protocol

QR + WebSocket session-engagement helpers, in the spirit of ISO 18013-5.

```ts
import {
  decodeSessionEngagement,
  resolveWsUrl,
  isPresentationEngagement,
  isSdJwtVc,
  PRESENTATION_PREDICATES,
} from '@owlid/sdk'

if (isPresentationEngagement(qrPayload)) {
  const engagement = decodeSessionEngagement(qrPayload)
  const ws = new WebSocket(resolveWsUrl(engagement.wsUrl))
  // negotiate proof_request → proof_response (SD-JWT VC presentation) over ws
}
```

Full message schema in [`src/presentation.ts`](src/presentation.ts).

## Encoding helpers

Common base64 / base64url / hex conversions for binary data crossing the WebAuthn / SD-JWT / network boundary:

```ts
import {
  bufferToBase64,
  base64ToBuffer,
  bufferToBase64url,
  base64urlToBuffer,
  bytesToHex,
  hexToBytes,
} from '@owlid/sdk'
```

## Configuration precedence

`configure()` is the explicit setter. The SDK also reads (in order):

1. Last call to `configure()` (in-memory)
2. `window.__OWLID_CONFIG__` (browser runtime injection)
3. Vite-style `import.meta.env.VITE_*` at build time
4. Localhost defaults (dev only)

See [`src/config.ts`](src/config.ts) for full resolver behaviour.

## License

MIT.
