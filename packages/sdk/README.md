# @owlid/sdk

TypeScript SDK for OwlID — privacy-preserving identity built on Midnight.

Crypto, WebAuthn, credential storage, presentation protocol, and the shared `configure()` runtime resolver. API clients (verification, issuer) are re-exported through subpaths.

```bash
bun add @owlid/sdk
```

## Quick start

```ts
import { configure } from '@owlid/sdk'

configure({
  verificationUrl: 'https://verify.example.com',
  issuerUrl: 'https://issuer.example.com',
  apiKey: process.env.OWLID_API_KEY,
})
```

Call once at app boot. Every API singleton in the SDK reads from this state. Browsers can also set `window.__OWLID_CONFIG__` for runtime config without rebuilds.

## Subpath exports

| Import                | Contents                                                               |
| --------------------- | ---------------------------------------------------------------------- |
| `@owlid/sdk`          | Config, WebAuthn, storage, encoding, presentation, native primitives   |
| `@owlid/sdk/verifier` | Re-exports `@owlid/verifier-client` (verification HTTP API singletons) |
| `@owlid/sdk/issuer`   | Re-exports `@owlid/issuer-client` (issuer HTTP API singletons)         |
| `@owlid/sdk/native`   | Direct alias to `@owlid/native-sdk` (NAPI / WASM crypto)               |

## Verifier integration

```ts
import { configure } from '@owlid/sdk'
import { getVerificationApi, getPresentationApi } from '@owlid/sdk/verifier'

configure({ verificationUrl, apiKey })

// 1. Direct token verification
const result = await getVerificationApi().verifyToken({
  verifyRequest: { token, challenge },
})
// → { valid, subjects?, error? }

// 2. QR / WebSocket presentation session
const session = await getPresentationApi().createSession()
// → { sessionId, wsUrl, nonce, expiresIn }
// Render `wsUrl` as a QR for the holder. Both sides connect to:
//   ws://host${wsUrl}?role=holder | ?role=verifier
```

## Issuer integration

```ts
import { configure } from '@owlid/sdk'
import { getSessionsApi, getCredentialsApi } from '@owlid/sdk/issuer'

configure({ issuerUrl })

const session = await getSessionsApi().createSession({
  createSessionRequest: { providerId: 'mock-digid' },
})

// After the holder completes the provider flow:
const issued = await getCredentialsApi().issueCredential({
  id: session.sessionId,
  issueCredentialRequest: { ownerPublicKey, keyAlgorithm: 'p256' },
})
```

## Native crypto primitives

Re-exported from `@owlid/native-sdk` (NAPI on Node, WASM in browsers):

```ts
import { Document, Credential, KeyPair, Token, blake3, sha256 } from '@owlid/sdk'

const issuer = KeyPair.generate()
const owner = KeyPair.generate()

const document = Document.fromJson(
  JSON.stringify({
    issuerKey: issuer.publicKey().toHex(),
    ownerKey: owner.publicKey().toHex(),
    firstName: 'Alice',
    dateOfBirth: '1990-05-15',
  }),
)

const credential = document.issue(issuer)

const token = credential.prove(
  {
    disclose: ['firstName'],
    predicates: [{ attribute: 'dateOfBirth', op: 'GreaterOrEqual', value: '18' }],
    trustedIssuers: [issuer.publicKey().toHex()],
    challenge: verifierChallenge,
  },
  owner,
  /* ttlSeconds */ 300,
)

const compact = token.toCompact() // "OID1:..."
```

## WebAuthn / passkeys

```ts
import { registerCredential, signChallenge, isWebAuthnSupported } from '@owlid/sdk'

if (!isWebAuthnSupported()) throw new Error('WebAuthn not available')

const cred = await registerCredential({
  rpName: 'My Wallet',
  rpId: 'wallet.example.com',
  userName: user.email,
  userVerification: 'required',
})

const sig = await signChallenge(cred.credentialId, challengeBytes)
```

For two-phase token signing (token bytes prepared by the native SDK, signed by the secure enclave, finalized client-side) use `Credential.prepare()` and `Token.finalizeWebauthn()` from the native exports.

## Credential storage

```ts
import { storage, proofStorage, CredentialStorageManager } from '@owlid/sdk'

// Default: localStorage-backed, suitable for browser wallets
await storage.saveCredential(proofDocumentJson)
const list = await storage.listCredentials()

// IndexedDB-backed proof history
await proofStorage.put({ id, tokenJson, createdAt })
```

`storage` and `proofStorage` are singletons. For custom storage backends (mobile, server-side test rigs), instantiate `CredentialStorageManager` directly with your own `StorageAdapter`.

## Presentation protocol (ISO 18013-5 style)

```ts
import {
  decodeSessionEngagement,
  resolveWsUrl,
  isPresentationEngagement,
  PRESENTATION_PREDICATES,
} from '@owlid/sdk'

if (isPresentationEngagement(qrPayload)) {
  const engagement = decodeSessionEngagement(qrPayload)
  const ws = new WebSocket(resolveWsUrl(engagement.wsUrl))
  // negotiate proof_request → proof_response over ws
}
```

Full message schema in [`src/presentation.ts`](src/presentation.ts).

## Encoding helpers

Common base64 / base64url / hex conversions for binary data crossing the WebAuthn / Token / network boundary:

```ts
import { bufferToBase64, base64ToBuffer, bytesToHex, hexToBytes } from '@owlid/sdk'
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
