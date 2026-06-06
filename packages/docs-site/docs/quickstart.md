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
  wrapHolderKey,
  unwrapHolderKey,
  presentSdJwtVc,
  registerCredential,
} from '@owlid/sdk'

// 1. Mint a passkey + a wallet-held holder key, PRF-wrap the 32-byte seed.
const passkey = await registerCredential({
  rpName: 'My Wallet',
  rpId: 'wallet.example.com', // your app's domain
  userName: 'alice',
})
const holder = KeyPair.generate()
const wrapped = await wrapHolderKey(passkey.credentialId, holder.toHex())

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

// 3. Build a presentation for a verifier (passkey UV gate inside unwrapHolderKey).
const holderKeyHex = await unwrapHolderKey(passkey.credentialId, wrapped)
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

For the QR / WebSocket flow in a single call, use `verifier.requestPresentation(...)` — see the [verifier guide](/integration/verifier).

---

## 5. Predicates

A **predicate** is a fact derived from a credential without revealing the underlying attribute — `age ≥ 18`, `kyc ≥ 2`, `nationality ∈ EU set`, verified residency or email, unique personhood.

Predicates are **proven by the holder's wallet, in zero knowledge, on the device**. The wallet derives a witness from the credential (birthdate, KYC level, …), generates a ZK proof locally, and submits it to Midnight, which verifies the proof and records an attestation. When the holder later presents, the verifier confirms that on-chain attestation. The underlying value never leaves the wallet, and the verifier never sees it.

| Predicate request claim       | Proves                                  |
| ----------------------------- | --------------------------------------- |
| `age_over_18` / `_21` / `_65` | Holder is at least that age.            |
| `nationality_eu`              | Holder's nationality is in the EU set.  |
| `verification_level`          | Holder's KYC level meets the threshold. |
| `resident`                    | Holder has verified residency.          |
| `email_verified`              | Holder's email was verified by the IdP. |
| `unique_person`               | One-human-one-claim (sybil resistance). |

The wallet runs the proof transparently — `OwlWallet.present` (and `verifier.requestPresentation`) attest any required predicate on first use, emitting `AttestProgress` events so your UI can show "Generating proof…". The attestation is one-time per credential and reused across every later presentation.

Plain attributes (`given_name`, `nationalities`, …) are ordinary SD-JWT VC disclosures — the holder reveals only the ones the verifier's DCQL query asks for.

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
