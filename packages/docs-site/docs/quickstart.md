# Quickstart

Build with Owl ID — standards-conformant SD-JWT VC issuance and verification (OpenID4VCI / OpenID4VP), anchored on Midnight, with WebAuthn/passkey-protected wallets.

This guide gets you running with `@owlid/sdk` against the **hosted Owl ID platform**. You don't run any Owl ID infrastructure.

---

## 1. Install

```bash
bun add @owlid/sdk
```

`@owlid/sdk` is pure TypeScript (`@noble/ed25519` + `@noble/hashes`) — no WASM, no native binaries, no bundler plugins. It runs in browsers, Node, and React Native shells.

Get an API key from the [operator dashboard](https://admin.owlid.app). Use a **secret** key (`owlid_sk_…`) on a server, or a **publishable** key (`owlid_pk_…`) in a browser build. The SDK targets the hosted platform by default — no URLs to configure.

---

## 2. Issue a credential

```typescript
import { OwlIssuer } from '@owlid/sdk'

const issuer = new OwlIssuer({ apiKey: process.env.OWLID_API_KEY! })

// 1. Open an issuance session for a provider.
const session = await issuer.startSession('didit')

// 2. Submit verified claims (form-based providers) using SD-JWT VC names.
await issuer.submitClaims(session.id, {
  given_name: 'Alice',
  family_name: 'Wonderland',
  birthdate: '1990-05-15',
  nationalities: ['NL'],
})

// 3. Issue — bound to the holder's confirmation key.
//    Returns { sdJwtVc } — the SD-JWT VC string in issuance form.
const issued = await issuer.issue(session.id, {
  publicKey: holderPublicKeyHex,
  algorithm: 'ed25519',
})
```

See the [issuer guide](/integration/issuer) for provider flow types, polling, and OpenID4VCI Batch issuance.

---

## 3. Receive, store, and present (holder)

```typescript
import {
  KeyPair,
  SdJwtVc,
  storage,
  buildCardShape,
  sealHolderKey,
  openHolderKey,
  presentSdJwtVc,
  registerCredential,
} from '@owlid/sdk'

// 1. Mint a passkey + a wallet-held holder key, PRF-seal the 32-byte seed.
const passkey = await registerCredential({
  rpName: 'My Wallet',
  rpId: 'wallet.example.com', // your app's domain
  userName: 'alice',
})
const holder = KeyPair.generate()
const { blob: wrapped } = await sealHolderKey(passkey.credentialId, holder.toHex())

// 2. Store the issued credential together with the wrapped key.
//    credentialId + issuer are derived from the SD-JWT VC itself.
const parsed = SdJwtVc.parse(issued.sdJwtVc)
await storage.addCredential(
  {
    credentialId: parsed.credentialId(),
    sdJwtVc: issued.sdJwtVc,
    issuer: parsed.peekIssuer(),
    providerId: 'didit',
    issuedAt: new Date().toISOString(),
    holderPublicKeyHex: holder.publicKeyHex(),
    verifiedClaims: { firstName: 'Alice' },
    cardShape: buildCardShape('didit', { firstName: 'Alice' }),
  },
  wrapped,
)

// 3. Build a presentation for a verifier (passkey UV gate inside openHolderKey).
const { seedHex: holderKeyHex } = await openHolderKey(passkey.credentialId, wrapped)
const presentation = presentSdJwtVc(
  issued.sdJwtVc,
  holderKeyHex,
  ['given_name', 'age_over_18'], // disclose only these
  { aud: verifierOrigin, nonce: verifierNonce }, // bound into the KB-JWT
)
```

See the [holder guide](/integration/holder) for the WebAuthn lifecycle, QR scanning, and `OwlWallet`.

---

## 4. Verify a presentation

```typescript
import { OwlVerifier } from '@owlid/sdk'

const verifier = new OwlVerifier({ apiKey: process.env.OWLID_API_KEY! })
const challenge = await verifier.mintChallenge()

// Send `challenge.challenge` to the holder; they bind it into the KB-JWT.
const result = await verifier.verify(presentation, challenge.challenge)
if (result.valid) {
  console.log(result.subjects) // { given_name: 'Alice', age_over_18: true }
}
```

For the QR / WebSocket flow in a single call, use `verifier.requestPredicates(...)` — see the [verifier guide](/integration/verifier).

---

## 5. Predicates

A **predicate** is a fact derived from a credential without revealing the underlying attribute — `age ≥ 18`, `kyc ≥ 2`, `nationality ∈ EU set`, verified residency or email, unique personhood.

Predicates are **proven by the holder's wallet, in zero knowledge, on the device**. The wallet derives a witness from the credential (birthdate, KYC level, …), generates a ZK proof locally, and submits it to Midnight, which verifies the proof and records an attestation. When the holder later presents, the verifier confirms that on-chain attestation. The underlying value never leaves the wallet, and the verifier never sees it.

Request them with the typed `Predicates` factory — it compiles to the DCQL claim path the wallet and verifier both route on:

```typescript
import { OwlVerifier, Predicates } from '@owlid/sdk'

const result = await verifier.requestPredicates({
  verifierName: 'Acme Bar',
  predicates: [Predicates.ageOver(18), Predicates.kycLevel('substantial')],
  onQr: (payload) => showQr(payload),
})
```

| Factory                                     | DCQL claim path        | Proves                                     |
| ------------------------------------------- | ---------------------- | ------------------------------------------ |
| `Predicates.ageOver(18)`                    | `age_over` + `values`  | Holder is at least that age.               |
| `Predicates.ageRange(18, 25)`               | `age_range` + `values` | Holder's age is within inclusive bounds.   |
| `Predicates.kycLevel('substantial')`        | `verification_level`   | Holder's KYC level meets the threshold.    |
| `Predicates.nationalityIn(['NL', 'BE'])`    | `nationality_in`       | Nationality is in your supplied set.       |
| `Predicates.residencyIn(['NL', 'BE'])`      | `resident_in`          | Residence country is in your supplied set. |
| `Predicates.emailVerified()`                | `email_verified`       | Holder's email was verified by the IdP.    |
| `Predicates.uniquePerson({ epoch, appId })` | `unique_person`        | One-human-one-claim (sybil resistance).    |

`nationality_eu` is also accepted as a legacy synonym for `nationality_in` over the EU-27 set.

The wallet runs the proof transparently — `OwlWallet.present` (and `verifier.requestPredicates`) attest any required predicate on first use, emitting `AttestProgress` events so your UI can show "Generating proof…". The attestation is one-time per credential and reused across every later presentation.

Plain attributes (`given_name`, `nationalities`, …) are ordinary SD-JWT VC disclosures — the holder reveals only the ones the verifier's DCQL query asks for. Some issuer-stamped booleans look predicate-shaped but are plain disclosures: `age_over_18`, `age_over_21`, `age_over_65`, and `resident` are values the issuer asserted, not on-device proofs. Use `Predicates.ageOver(18)` / `Predicates.residencyIn([...])` when you want the zero-knowledge version.

Discover the predicates the platform can prove at startup with `OwlVerifier.listPredicates()`.

---

## 6. Hosted apps

Don't want to build a client at all? The platform ships ready-to-use apps — see [Owl ID apps](/apps):

- [**Wallet**](https://wallet.owlid.app) — holders receive and present credentials.
- [**Verifier**](https://verifier.owlid.app) — browser scanner for kiosk / low-volume verification.
- [**Operator dashboard**](https://admin.owlid.app) — API keys, trusted issuers, revocations, metrics.

---

## What's next

- [SDK reference](/sdk/verifier) — every class and method
- [Real-world scenarios](/examples/scenarios) — age gates, KYC, ticketing, anti-bot, and more
- [HTTP API](/api) — raw endpoints, for non-TypeScript integrations
- [How Owl ID works](/architecture/overview) — design rationale, threat model, data flow
