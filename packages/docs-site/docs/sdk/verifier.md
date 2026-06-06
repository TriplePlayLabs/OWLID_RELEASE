# OwlVerifier

Server-side client for verifying Owl ID SD-JWT VC presentations. Imported from `@owlid/sdk`.

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

### `verify(presentation, challenge, audience?)`

Confirm a single-credential SD-JWT VC presentation against a challenge. The platform checks the issuer signature (resolved via did:web against the on-chain `issuer_registry`), each disclosure's salt-hash, the holder's KB-JWT (audience + nonce binding), `nbf`/`exp`, and revocation (IETF Token Status List + on-chain `revocation_registry`) in a single round trip.

```ts
const result = await verifier.verify(presentation, challenge)
// VerificationResult
//   valid: boolean
//   subjects?: Record<string, unknown>   // disclosed claims
//   error?: string                       // reason if !valid
```

`challenge` must match what the holder bound into the KB-JWT. If you minted it via `mintChallenge()`, the platform consumes it atomically — replays fail. Pass `audience` to also assert the KB-JWT `aud`.

This is a thin wrapper over `verifyDcql` that builds a one-entry `vp_token`. For multi-credential presentations use `verifyDcql` directly.

### `verifyDcql(vpToken, challenge, audience?, query?)`

Verify a DCQL `vp_token` (OpenID4VP 1.0 §6 + §8.1). `vpToken` is a map keyed by DCQL credential id; each value is an SD-JWT VC presentation. Every KB-JWT must be signed over the same `challenge`.

```ts
const r = await verifier.verifyDcql({ cred0: presentationA, cred1: presentationB }, challenge)
// VerifyDcqlResponse
//   valid:         boolean
//   perCredential: Record<string, { subjects?, error? }>  // keyed by DCQL id
//   error?:        string
```

When `query` is omitted the platform accepts whatever the holder discloses. Pass a real DCQL query when you need `format` / `meta` / `claims` / `credential_sets` constraints enforced.

### `mintChallenge()`

Mint a single-use server-managed challenge. The platform stores it and consumes it on the matching `verify()` call.

```ts
const { challenge, expiresIn } = await verifier.mintChallenge()
```

If you don't need platform-managed replay protection, you can also pass your own random string straight to `verify()`.

### `requestPredicates(opts)` — declarative one-call QR flow ⭐

Preferred API for the common case: ask the holder to satisfy a list of typed predicates, get back a verified result. No DCQL hand-rolling.

```ts
import { OwlVerifier, Predicates } from '@owlid/sdk'

const result = await verifier.requestPredicates({
  verifierName: 'Acme Bar',
  predicates: [
    Predicates.ageOver(18),
    Predicates.residencyIn(['NL', 'BE', 'DE']),
    Predicates.kycLevel('substantial'),
  ],
  onQr: (payload) => showQr(payload),
  timeoutMs: 60_000,
})

if (result.valid) console.log(result.perCredential.cred0?.subjects)
```

The full `Predicates` factory:

| Factory                                               | Compact circuit          | Notes                                                                                                                                |
| ----------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Predicates.ageOver(threshold)`                       | `attestAgeGte`           | Holder proves `age >= threshold`. Age never disclosed.                                                                               |
| `Predicates.ageRange(min, max)`                       | `attestAgeRange`         | Inclusive bounds.                                                                                                                    |
| `Predicates.kycLevel('basic'\|'substantial'\|'high')` | `attestKycGte`           | eIDAS-style identity verification tier; numeric input also accepted.                                                                 |
| `Predicates.residencyIn(['NL', 'BE', 'DE'])`          | `attestResidencyIn`      | Holder's residence country is in the verifier-supplied set. Per-verifier salted, Merkle-witnessed; neither set nor country on chain. |
| `Predicates.nationalityIn([...])`                     | `attestNationalityIn`    | Same shape as `residencyIn` for nationality.                                                                                         |
| `Predicates.emailVerified()`                          | `attestEmailVerified`    | Issuer-attested email-verified flag.                                                                                                 |
| `Predicates.uniquePerson({ epoch, appId })`           | `attestUniquePersonhood` | Sybil-resistant per-campaign nullifier; same human → same nullifier per `(epoch, appId)`, unlinkable across scopes.                  |

Each `requestPredicates` call opens a session, renders the QR via `onQr`, waits for the holder, runs verification, and returns the merged `VerifyDcqlResponse`. Browser-only (uses the global `WebSocket`). For server flows compose `openPresentation()` + your own WS client + `verifyDcql`.

### `buildDcqlRequest(predicates)` — get the raw DCQL

Compile predicates to the on-wire DCQL request when you need it (publishing a `request_uri`, feeding an external wallet, etc.).

```ts
const dcql = verifier.buildDcqlRequest([Predicates.ageOver(21)])
// { credentials: [{ id: 'cred0', format: 'dc+sd-jwt', claims: [...] }] }
```

### `requestPresentation(options)` — low-level QR flow

Same flow as `requestPredicates` but takes a raw `DcqlRequest`. Use this only when you need DCQL features the `Predicates` factory doesn't cover yet (e.g. `credential_sets`).

```ts
const result = await verifier.requestPresentation({
  verifierName: 'Acme Bar',
  verifierId: 'https://acme.example',
  dcql: verifier.buildDcqlRequest([Predicates.ageOver(18)]),
  onQr: (payload) => showQr(payload),
})
```

| Option         | Type                          | Notes                                                                    |
| -------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `verifierName` | `string`                      | Required. Shown on the holder's consent screen.                          |
| `verifierId`   | `string`                      | OID4VP `client_id`. Defaults to `verifier.verifierId()` (its `baseUrl`). |
| `dcql`         | `DcqlRequest`                 | Required. OpenID4VP 1.0 §6 DCQL credential request.                      |
| `onQr`         | `(qrPayload: string) => void` | Called once the session opens. Render this as a QR code.                 |
| `timeoutMs`    | `number`                      | Defaults to 90 s.                                                        |

### `openPresentation()` — manual control

If you need to manage the WebSocket yourself:

```ts
const session = await verifier.openPresentation()
// PresentationSession
//   sessionId:     string
//   wsUrl:         string  // path
//   nonce:         string  // bound into the holder's KB-JWT
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

### `listPredicates()`

List every predicate the platform can prove. Render your proof selector / consent UI from this list rather than hard-coding claim names.

```ts
const predicates = await verifier.listPredicates()
// Predicate[]
//   id:        string   // canonical id, e.g. 'age:>=18' or 'nationality:eu'
//   attribute: string   // credential attribute the predicate reads
//   label:     string   // human-readable label
//   op:        'GreaterOrEqual' | 'InSet'
//   value:     string   // JSON-encoded wire value
```

### `listCircuitDatasets()` / `getCircuitDataset(name)`

List the set-membership datasets the circuits know about (`name` + `version`), or fetch one dataset's full contents. Used by `InSet` predicates such as `nationality:eu`.

```ts
const datasets = await verifier.listCircuitDatasets()
// [{ name: 'eu', version: 1 }, …]

const eu = await verifier.getCircuitDataset('eu')
// { name: 'eu', version: 1, items: ['AT', 'BE', …] }
```

### `verifierId()`

The verifier's stable OID4VP `client_id`. Defaults to its `baseUrl`. Folded into per-verifier salts so two verifiers asking for the same allowed-set produce distinct on-chain attestation keys (anti-cross-verifier correlation on well-known policies).

```ts
verifier.verifierId() // 'https://api.owlid.app' (or your custom baseUrl)
```

### `computeAllowedSetHash(countries)`

Off-chain SHA-256 commitment to your verifier-supplied country list. Useful for dashboards counting attestations under your own policy, or for publishing to an off-chain audit registry.

```ts
const setHash = await verifier.computeAllowedSetHash(['NL', 'BE', 'DE'])
// '8f12...' (64-char hex)
```

Canonicalises input (sort + dedupe + uppercase) before hashing, so request ordering doesn't matter. Same value the on-chain attestation key is bound to.

### `attestationKeyFor(credentialId, predicate)`

Recompute the on-chain attestation lookup key for a `(credential, predicate)` pair. Useful for verifier dashboards or off-chain audit tools that need the key without round-tripping `/predicates/attested`.

```ts
const key = await verifier.attestationKeyFor(
  '635867bc...', // 32-byte hex credential_id
  Predicates.residencyIn(['NL', 'BE']),
)
// '06d8de25a0...' (64-char hex)
```

Per-verifier salt is automatically folded in for set-membership predicates via `verifierId()`.

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

All methods throw on transport / auth failures. `verify()` itself returns `{ valid: false, error }` for cryptographic failures (untrusted issuer, expired, revoked, KB-JWT audience/nonce mismatch, did:web doc-hash mismatch) — these are a normal part of the flow, not exceptions.
