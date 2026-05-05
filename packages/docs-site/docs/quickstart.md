# Quickstart

Get OwlID working in your product in five minutes. Pick the persona that matches what you're building.

## 1. Get an API key

Sign up at [owlid.dev](https://owlid.dev) and mint a key from your dashboard. Keys are prefixed: `owlid_pk_…` (publishable, browser-safe, verify only) or `owlid_sk_…` (secret, server only).

## 2. Install the SDK

```bash
bun add @owlid/sdk
```

## 3. Use the SDK

### Verifier — confirm a credential

```ts
import { OwlVerifier } from '@owlid/sdk'

const verifier = new OwlVerifier({ apiKey: process.env.OWLID_API_KEY! })

const challenge = await verifier.mintChallenge()
const result = await verifier.verify(token, challenge.challenge)

if (result.valid) {
  console.log(result.subjects) // disclosed attributes
} else {
  console.log(result.error)
}
```

### Issuer — mint a credential

```ts
import { OwlIssuer } from '@owlid/sdk'

const issuer = new OwlIssuer({ apiKey: process.env.OWLID_API_KEY! })

const session = await issuer.startSession('didit')
// ...holder runs the provider flow...
const credential = await issuer.issue(session.id, {
  publicKey: holderPublicKey,
  algorithm: 'p256',
})
// Send credential.document to the holder.
```

### Holder app — generate a token

```ts
import { Credential, KeyPair } from '@owlid/sdk'

const credential = Credential.fromJson(storedDocumentJson)
const ownerKey = KeyPair.fromHex(privateKeyHex)

const token = credential.prove(
  {
    disclose: ['firstName'],
    predicates: [{ attribute: 'dateOfBirth', op: 'GreaterOrEqual', value: '18' }],
    trustedIssuers: [issuerPublicKeyHex],
    challenge: verifierChallenge,
  },
  ownerKey,
  /* ttlSeconds */ 300,
)

const compact = token.toCompact() // "OID1:..." — fits a QR
```

Hidden attributes never leave the holder's device. The verifier sees only what the holder chose to disclose plus any zero-knowledge predicate proofs.

## Next

- [Verifier integration](/integration/verifier) — full verification flow + presentation sessions
- [Issuer integration](/integration/issuer) — provider flows, KYC integration
- [Holder integration](/integration/holder) — wallet building blocks
- [SDK reference](/sdk/verifier) — every method, every type
