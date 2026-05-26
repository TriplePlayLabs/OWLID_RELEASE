# Real-world scenarios

Concrete products you can build with OwlID. Each shows the user-facing flow plus the SDK calls that drive it.

Two building blocks recur:

- **Disclosures** — plain SD-JWT VC claims (`given_name`, `nationalities`, …). The holder reveals only the ones your DCQL query asks for.
- **Predicates** — facts proven by the holder's wallet in zero knowledge on the device, then attested on Midnight (`age_over_18`, `verification_level`, `nationality_eu`, `resident`, `email_verified`, `unique_person`). The underlying value never leaves the wallet; you request the predicate and `verify` / `requestPresentation` enforce it. See [How OwlID works](/architecture/overview).

`requestPresentation` returns a `VerifyDcqlResponse` — `valid` plus a `perCredential` map keyed by your DCQL `credentials[].id`.

---

## 1. Age gate for a bar / venue

Goal: confirm a customer is 18+ before serving alcohol. No name, no birthday — just the green check.

```ts
import { OwlVerifier } from '@owlid/sdk'

const verifier = new OwlVerifier({ apiKey: process.env.OWLID_API_KEY! })

const result = await verifier.requestPresentation({
  verifierName: 'Acme Bar',
  dcql: {
    credentials: [{ id: 'cred0', format: 'dc+sd-jwt', claims: [{ path: ['age_over_18'] }] }],
  },
  onQr: (qrPayload) => terminal.showQr(qrPayload),
  timeoutMs: 60_000,
})

if (result.valid) bar.allowEntry()
else bar.deny(result.error)
```

`age_over_18` is a predicate: the wallet derives the holder's age from their credential, proves `age ≥ 18` in zero knowledge on the device, and Midnight records an attestation. The bar sees `valid: true` and the issuer's `did:web` identifier — **never** the name, exact age, birthdate, address, or document number.

**Privacy properties**

- The witness (the birthdate) is consumed inside the on-device proof and never leaves the wallet.
- The verifier nonce is single-use — a recorded presentation cannot be replayed.
- The KB-JWT is signed by a wallet-held key the holder unlocked with their passkey; the wallet never exports the key.
- The first proof on a device takes a few seconds; the attestation is then reused across every later age check.

---

## 2. Proof of unique humanity — anti-bot signup

Goal: a forum, waitlist, or community wants **one account per real human** — no bots, no mass fake signups — without learning anyone's identity.

This is the `unique_person` predicate. The verifier picks a 32-byte **scope**: an `epoch` (the campaign) and an `app_id` (your app). The wallet proves the holder controls a unique personhood secret and derives a per-scope nullifier; Midnight rejects a second claim under the same scope. One human can attest once — and stays uncorrelated across other apps and campaigns.

```ts
import { OwlVerifier } from '@owlid/sdk'

const verifier = new OwlVerifier({ apiKey: process.env.OWLID_API_KEY! })

// `epoch` + `app_id` are 32-byte hex (64 hex chars) you control.
// `epoch` = the campaign scope, `app_id` = your application.
// Keep both stable to enforce "one signup per human, ever".
const EPOCH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
const APP_ID = 'ac4ed00000000000000000000000000000000000000000000000000000000001'

const result = await verifier.requestPresentation({
  verifierName: 'Acme Community',
  dcql: {
    credentials: [
      {
        id: 'cred0',
        format: 'dc+sd-jwt',
        claims: [{ path: ['unique_person'], values: [{ epoch: EPOCH, app_id: APP_ID }] }],
      },
    ],
  },
  onQr: (payload) => signup.showQr(payload),
})

if (result.valid) signup.createAccount()
else signup.deny('Already registered, or not a verified human.')
```

The signup form learns nothing else — no email, no document, no profile data — and gets bot-resistance and one-account-per-human for free. A user who already signed up cannot do it twice: their nullifier for this `(epoch, app_id)` is already on-chain.

> **Pick the scope deliberately.** Reuse the same `epoch` everywhere you want "one claim total" (one signup ever). Rotate the `epoch` per season/round when you want "one claim per round". Different `app_id`s never correlate to the same human.

---

## 3. Ticketing without scalping

Goal: gate a paid event. Each ticket is a credential issued at purchase; at the door the holder proves the ticket **and** that they are a unique human — so a screenshot, a resold QR, or one person walking in ten friends all fail.

**Issuance** — when someone buys a ticket, your back office mints a credential bound to the buyer's wallet key:

```ts
import { OwlIssuer } from '@owlid/sdk'

const issuer = new OwlIssuer({ apiKey: process.env.OWLID_API_KEY! })

const session = await issuer.startSession('owlcon-checkout')
await issuer.submitClaims(session.id, {
  event_id: 'OWLCON-2026',
  tier: 'vip',
  ticket_id: ticket.id,
})
const credential = await issuer.issue(session.id, {
  publicKey: holderPublicKey,
  algorithm: 'ed25519',
})
// hand `credential.sdJwtVc` to the buyer's wallet to store
```

**At the door** — the scanner asks for the event + tier disclosures **and** a unique-person proof scoped to this event:

```ts
import { OwlVerifier } from '@owlid/sdk'

const verifier = new OwlVerifier({ apiKey: process.env.OWLID_DOOR_KEY! })

// 32-byte hex scope (64 hex chars) — one entry per human for this event.
const EPOCH = 'e7e0700000000000000000000000000000000000000000000000000000202601'
const APP_ID = 'd00r500000000000000000000000000000000000000000000000000000a0b12'

const result = await verifier.requestPresentation({
  verifierName: 'OwlCon 2026 Entrance',
  dcql: {
    credentials: [
      {
        id: 'cred0',
        format: 'dc+sd-jwt',
        claims: [
          { path: ['event_id'] },
          { path: ['tier'] },
          { path: ['unique_person'], values: [{ epoch: EPOCH, app_id: APP_ID }] },
        ],
      },
    ],
  },
  onQr: (payload) => scanner.showQr(payload),
  timeoutMs: 30_000,
})

const subjects = result.perCredential.cred0?.subjects
if (result.valid && subjects?.event_id === 'OWLCON-2026' && subjects?.tier === 'vip') {
  scanner.unlockGate()
}
```

**Why it beats QR-image tickets**

- The KB-JWT binds to the door's single-use nonce — a screenshot replays as `valid: false`, and the wallet signs each presentation fresh with the holder's unlocked key.
- The `unique_person` proof, scoped to this event's `epoch`, lets each human through **once**. A resold or shared ticket fails the second scan: the buyer's nullifier for this event is already on-chain.
- If a ticket is refunded or charged back, the issuer revokes the credential; the door sees it in real time via `subscribeRevocations`.
- Hidden disclosures stay hidden — put the buyer's name in the credential for support without the door scanner ever asking for it.

**Multi-day passes** — use a distinct `epoch` per day; the same credential then admits each human once per day.

---

## 4. KYC-gated onboarding

Goal: a remote-work or fintech platform requires every user to have completed at least KYC tier 2 with any approved provider.

```ts
const result = await verifier.requestPresentation({
  verifierName: 'Acme Talent',
  dcql: {
    credentials: [
      {
        id: 'cred0',
        format: 'dc+sd-jwt',
        claims: [
          { path: ['given_name'] },
          { path: ['family_name'] },
          { path: ['verification_level'], values: ['substantial'] },
        ],
      },
    ],
  },
  onQr: (payload) => onboarding.showQr(payload),
})

const subjects = result.perCredential.cred0?.subjects
if (result.valid) {
  await onboarding.complete({
    firstName: subjects?.given_name,
    lastName: subjects?.family_name,
  })
}
```

`given_name` / `family_name` come back as plain disclosures. `verification_level` is a predicate — the wallet proves the KYC threshold (`'basic'` / `'substantial'` / `'high'`, or a numeric level) on-device and the verifier confirms the on-chain attestation. The platform never sees the underlying KYC report or document image.

---

## 5. EU-only marketplace

Goal: a service operates only in the EU and needs to confirm sellers are EU nationals — without learning the exact country.

```ts
const result = await verifier.requestPresentation({
  verifierName: 'EU Marketplace',
  dcql: {
    credentials: [{ id: 'cred0', format: 'dc+sd-jwt', claims: [{ path: ['nationality_eu'] }] }],
  },
  onQr: (payload) => listing.renderQr(payload),
})

if (result.valid) listing.publish()
```

`nationality_eu` is a set-membership predicate: the wallet proves the holder's nationality is in the approved EU set in zero knowledge. The verifier learns only the boolean — not which country. (To collect the specific country instead, request the `nationalities` disclosure.)

---

## 6. Fair distribution — one human, one claim

Goal: an airdrop, a public-goods grant, or a one-person-one-vote ballot must reach each real human exactly once. No sybil farms, no wallet-splitting.

```ts
import { OwlVerifier } from '@owlid/sdk'

const verifier = new OwlVerifier({ apiKey: process.env.OWLID_API_KEY! })

// 32-byte hex scope — bump `epoch` each round so every human can claim again.
const EPOCH = '00c7a0000000000000000000000000000000000000000000000000000000ee00'
const APP_ID = '00d0a0000000000000000000000000000000000000000000000000000000bb00'

const result = await verifier.requestPresentation({
  verifierName: 'OwlDAO Grant Round 7',
  dcql: {
    credentials: [
      {
        id: 'cred0',
        format: 'dc+sd-jwt',
        claims: [{ path: ['unique_person'], values: [{ epoch: EPOCH, app_id: APP_ID }] }],
      },
    ],
  },
  onQr: (payload) => claim.showQr(payload),
})

if (result.valid) await disburse(claim.recipientAddress)
```

Each human's nullifier for `owldao-grant-round-7` lands on-chain on first claim, so a second attempt — even from a different wallet or device — fails. The DAO learns "a unique human claimed", never _who_. Rotate the `epoch` to `round-8` next time and every human can claim again.

---

## 7. Email-verified contact, age-bracketed content

Goal: smaller checks that pair a predicate with a disclosure.

```ts
// Newsletter — confirm a provider-verified email without an email round-trip.
dcql: {
  credentials: [
    {
      id: 'cred0',
      format: 'dc+sd-jwt',
      claims: [{ path: ['email_verified'] }, { path: ['email'] }],
    },
  ]
}

// Mature content — 21+ without name or birthday.
dcql: {
  credentials: [{ id: 'cred0', format: 'dc+sd-jwt', claims: [{ path: ['age_over_21'] }] }]
}

// Resident-only service — verified residency, no address.
dcql: {
  credentials: [{ id: 'cred0', format: 'dc+sd-jwt', claims: [{ path: ['resident'] }] }]
}
```

`email_verified`, `age_over_21`, `resident` are predicates (proven on-device); `email` is a plain disclosure the holder reveals alongside the proof.

---

## 8. Stolen-device credential revocation

Goal: a user's phone is stolen. The issuer revokes the credential; subsequent verifications fail immediately and verifiers can drop cached results.

Issuer side (operator dashboard or back office):

```
POST /revocations/revoke
{ "credentialId": "...", "issuerPublicKey": "...", "reason": "device-lost" }
```

Requires an API key with the `admin` permission. The verification service writes through to the on-chain `revocation_registry` (via the sidecar) and broadcasts the change over `/ws/revocations`.

Verifier side, optional live invalidation:

```ts
const unsubscribe = verifier.subscribeRevocations((event) => {
  cache.invalidate(event.credentialId)
})
```

The next `verify()` call returns `{ valid: false, error: 'Credential revoked' }`. The signed `statuslist+jwt` at the issuer's `/status/{id}` reflects the change on its next fetch — the verifier consults both the live mirror and the status list.

---

## 9. GDPR right-to-erasure

Goal: an EU resident exercises their right to be forgotten. Their identifying data on the platform is anonymized; cryptographic audit trails remain hash-only.

The user (or their support rep) triggers erasure from the operator dashboard. The platform:

1. Revokes every active credential bound to the holder's `credential_id` set.
2. Replaces stored claim data with anonymized placeholders.
3. Retains hash-only audit records (compliance) but strips PII.
4. Returns a signed receipt the user keeps as proof.

OwlID is designed so the platform mostly stores hashes already — there is very little PII to erase. The flow exists for compliance, not because the system retains a copy of the user's documents.

---

## Common patterns

- **Render the QR full-screen** so phones don't have to crop the camera frame.
- **Use a short challenge TTL** (60 s) for unattended kiosks, longer (5 min) for online flows.
- **Cache verification results** keyed by `credential_id` hash; expire on TTL or a revocation push event.
- **Choose `unique_person` scopes deliberately** — a stable `epoch` for "once ever", a rotating `epoch` for "once per round". Different `app_id`s never correlate.
- **Expect a one-time delay** the first time a holder proves a predicate on a new device (a few seconds of on-device proving); it is reused after that.
- **Map `result.error` to friendly messages** — the platform returns codes like `Credential revoked`, `KB-JWT audience mismatch`, `Untrusted issuer`, `predicate not attested`.
- **For unlinkability across verifiers**, ask the issuer for a Batch (`OwlIssuer.issueBatch`) and present a fresh one-time-use credential each time.
