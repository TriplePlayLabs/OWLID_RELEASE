<!-- AUTO-GENERATED — do not edit. Source: docs/sdk/issuer.md -->

# OwlIssuer

Server-side client for issuing OwlID credentials. Imported from `@owlid/sdk`.

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

Read your issuer's public details (name + signing public key).

```ts
const { name, publicKey } = await issuer.info()
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

Submit verified identity claims for form-based providers.

```ts
await issuer.submitClaims(session.id, {
  firstName: 'Jan',
  lastName: 'de Vries',
  dateOfBirth: '1985-03-15',
  nationality: 'NL',
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

Issue a credential bound to the holder's public key. Throws if the session is not in `verified` state or if issuance fails.

```ts
const issued = await issuer.issue(session.id, {
  publicKey: '04abc...',
  algorithm: 'p256', // 'p256' for WebAuthn passkeys, 'ed25519' for raw keys
})
// IssuedCredential
//   document: Record<string, unknown>   // ProofDocument JSON, send to holder
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
  publicKey: string
  algorithm?: 'p256' | 'ed25519'
}

interface IssuedCredential {
  document: Record<string, unknown>
}
```
