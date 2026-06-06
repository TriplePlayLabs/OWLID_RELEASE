# OwlIssuer

Server-side client for issuing Owl ID SD-JWT VC credentials. Imported from `@owlid/sdk`.

```ts
import { OwlIssuer } from '@owlid/sdk'

const issuer = new OwlIssuer({ apiKey: process.env.OWLID_API_KEY! })
```

## Constructor

```ts
new OwlIssuer(options: OwlIssuerOptions)
```

| Option    | Type     | Notes                                                   |
| --------- | -------- | ------------------------------------------------------- |
| `apiKey`  | `string` | Required. Mint from your account dashboard.             |
| `baseUrl` | `string` | Optional override. Defaults to the hosted Owl platform. |

## Methods

### `info()`

Read your issuer's public details (display name + signing public key).

```ts
const { name, publicKey } = await issuer.info()
// IssuerInfo
//   name:      string
//   publicKey: string   // issuer signing public key, hex
```

### `listProviders()`

List identity providers configured for your account.

```ts
const providers = await issuer.listProviders()
// ProviderInfo[]
//   id:       string
//   name:     string
//   flowType: string
```

### `startSession(providerId)`

Open an issuance session for a given provider. The returned `start` payload tells you how to drive the provider flow.

```ts
const session = await issuer.startSession('didit')
// IssuanceSession
//   id:         string
//   providerId: string
//   status:     'pending' | 'verified' | 'complete' | 'expired'
//   flowType:   'form_based' | 'oidc_redirect' | 'saml_redirect' | 'webhook_async' | 'qr_polling'
//   expiresAt:  string  // ISO timestamp
//   start:      SessionStart
```

`session.start` is a discriminated union:

```ts
type SessionStart =
  | { type: 'form'; fields: FormField[] }
  | { type: 'redirect'; url: string; relayState?: string }
  | { type: 'qr'; qrData: string; orderRef: string; autoStartUrl?: string }
  | { type: 'webhook'; url: string }
```

### `submitClaims(sessionId, claims)`

Submit verified identity claims for form-based providers. Use SD-JWT VC standard claim names (`given_name`, `family_name`, `birthdate`, `nationalities`, …) where applicable.

```ts
await issuer.submitClaims(session.id, {
  given_name: 'Jan',
  family_name: 'de Vries',
  birthdate: '1985-03-15',
  nationalities: ['NL'],
})
```

### `getSession(sessionId)`

Read the current state of a session. Same shape as `startSession`.

### `getClaims(sessionId)`

Read verified claims once a session reaches `verified`.

```ts
const claims = await issuer.getClaims(session.id)
// IssuedClaims (provider-specific keys)
//   providerId: string
//   ...
```

### `poll(sessionId)`

Polls a session and returns the latest snapshot. Use this for QR or webhook flows where the provider drives the verification asynchronously.

```ts
let snapshot = await issuer.poll(session.id)
while (snapshot.status === 'pending') {
  await new Promise((r) => setTimeout(r, 1500))
  snapshot = await issuer.poll(session.id)
}
```

### `issue(sessionId, holder)`

Issue a single SD-JWT VC bound to the holder's confirmation key. Throws if the session is not in `verified` state or if issuance fails.

```ts
const issued = await issuer.issue(session.id, {
  publicKey: '04abc...', // holder public key, hex
  algorithm: 'ed25519', // 'ed25519' (wallet key) or 'p256' (ES256 cnf); defaults to 'p256'
})
// IssuedCredential
//   sdJwtVc: string   // application/dc+sd-jwt string, issuance form
```

The wallet derives the stable `credentialId` and the did:web `issuer` from the `sdJwtVc` string itself via [`SdJwtVc.parse()`](/sdk/primitives) — they are not separate fields on the response.

### `issueBatch(sessionId, holder, batchSize)`

Issue a batch of one-time-use SD-JWT VCs (OpenID4VCI Batch Credential endpoint). Each has a distinct `credential_id` and is independently revocable on Midnight — multiple presentations cannot be correlated by a colluding verifier pair.

```ts
const batch = await issuer.issueBatch(
  session.id,
  { publicKey: '04abc...', algorithm: 'ed25519' },
  8, // batchSize, 1..=64
)
// batch: IssuedCredential[]
```

The platform does not retain unhashed claims past the session TTL.

## Types

```ts
interface OwlIssuerOptions {
  apiKey: string
  baseUrl?: string
}

interface IssuanceSession {
  id: string
  providerId: string
  status: string
  flowType: string
  expiresAt: string
  start: SessionStart
}

interface FormField {
  name: string
  label: string
  type: string
  required: boolean
}

interface Holder {
  /** Holder public key, hex. */
  publicKey: string
  /** Key algorithm. Defaults to `p256` (WebAuthn). */
  algorithm?: 'p256' | 'ed25519'
}

interface IssuedCredential {
  sdJwtVc: string
}
```
