<!-- AUTO-GENERATED — do not edit. Source: docs/sdk/verifier.md -->

# OwlVerifier

Server-side client for verifying OwlID tokens. Imported from `@owlid/sdk`.

```ts
import { OwlVerifier } from '@owlid/sdk'

const verifier = new OwlVerifier({ apiKey: process.env.OWLID_API_KEY! })
```

## Constructor

```ts
new OwlVerifier(options: OwlVerifierOptions)
```

| Option    | Type     | Notes                                                   |
| --------- | -------- | ------------------------------------------------------- |
| `apiKey`  | `string` | Required. Mint from your account dashboard.             |
| `baseUrl` | `string` | Optional override. Defaults to the hosted Owl platform. |

## Methods

### `verify(token, challenge)`

Confirm a token against a challenge. The platform checks the issuer signature, Merkle proofs, ZK predicate proofs, expiry, and revocation in a single round trip.

```ts
const result = await verifier.verify(token, challenge)
// VerificationResult
//   valid: boolean
//   subjects?: Record<string, unknown>   // disclosed attributes
//   error?: string                       // reason if !valid
```

`challenge` must match what the holder bound into the token. If you minted it via `mintChallenge()`, the platform consumes it atomically — replays fail.

### `mintChallenge()`

Mint a single-use server-managed challenge. The platform stores it and consumes it on the matching `verify()` call.

```ts
const { challenge, expiresIn } = await verifier.mintChallenge()
```

If you don't need platform-managed replay protection, you can also pass your own random string straight to `verify()`.

### `requestPresentation(options)` — one-call QR flow

Single call that opens a session, renders the QR (via your callback), waits for the holder to push a token, and returns the verification result. Wraps the WebSocket lifecycle for you.

```ts
const result = await verifier.requestPresentation({
  verifierName: 'Acme Bar',
  predicates: [{ id: 'isOver18', label: 'Over 18' }],
  disclose: [],
  onQr: (payload) => showQr(payload),
  timeoutMs: 60_000,
})

if (result.valid) console.log(result.subjects)
```

| Option         | Type                          | Notes                                                    |
| -------------- | ----------------------------- | -------------------------------------------------------- |
| `verifierName` | `string`                      | Required. Shown on the holder's consent screen.          |
| `predicates`   | `{ id, label }[]`             | Zero-knowledge predicates the holder must prove.         |
| `disclose`     | `string[]`                    | Attribute names to disclose in plaintext.                |
| `onQr`         | `(qrPayload: string) => void` | Called once the session opens. Render this as a QR code. |
| `timeoutMs`    | `number`                      | Defaults to 90 s.                                        |

Browser-only (uses the global `WebSocket`). For server flows use `openPresentation()` plus your own WS client.

### `openPresentation()` — manual control

If you need to manage the WebSocket yourself:

```ts
const session = await verifier.openPresentation()
// PresentationSession
//   sessionId:     string
//   wsUrl:         string  // path
//   nonce:         string  // bound into the holder's token
//   expiresIn:     number  // seconds
//   verifierWsUrl: string  // full WS URL with ?role=verifier
//   qrPayload:     string  // base64url-encoded engagement, encode as QR
```

The session `nonce` becomes the `challenge` for the eventual `verify()` call.

### `subscribeRevocations(handler)`

Browser-only. Subscribes to live revocation events so you can invalidate cached verification results.

```ts
const unsubscribe = verifier.subscribeRevocations((event) => {
  // RevocationEvent
  //   credentialId: string
  //   status:       'revoked' | 'suspended' | 'reactivated'
  //   reason?:      string
})

// later
unsubscribe()
```

In Node, call `verifier.revocationFeedUrl()` and connect with `node:ws` directly.

### `revocationFeedUrl()`

Returns the WebSocket URL for the live revocation feed. Useful if you want to manage the connection yourself (Node, custom retry logic, etc.).

### `listIssuers()`

List trusted issuers visible to your account.

```ts
const issuers = await verifier.listIssuers()
// IssuerInfo[]
//   publicKey:    string
//   name:         string
//   description?: string
//   isActive:     boolean
```

## Types

```ts
interface VerificationResult {
  valid: boolean
  subjects?: Record<string, unknown>
  error?: string
}

interface Challenge {
  challenge: string
  expiresIn: number
}

interface PresentationSession {
  sessionId: string
  wsUrl: string
  nonce: string
  expiresIn: number
  verifierWsUrl: string
  qrPayload: string
}

interface RevocationEvent {
  credentialId: string
  status: 'revoked' | 'suspended' | 'reactivated'
  reason?: string
}
```

## Errors

All methods throw on transport / auth failures. `verify()` itself returns `{ valid: false, error }` for cryptographic failures (untrusted issuer, expired, revoked, challenge mismatch) — these are a normal part of the flow, not exceptions.
