<!-- AUTO-GENERATED — do not edit. Source: docs/E2E_SCENARIOS.md -->

# Real-world scenarios

Concrete products you can build with OwlID. Each shows the user-facing flow plus the SDK calls that drive it.

## 1. Age gate for a bar / venue

Goal: confirm a customer is 18+ before serving alcohol. No name, no birthday — just the green check.

```ts
import { OwlVerifier } from '@owlid/sdk'

const verifier = new OwlVerifier({ apiKey: process.env.OWLID_API_KEY! })

const result = await verifier.requestPresentation({
  verifierName: 'Acme Bar',
  predicates: [{ id: 'isOver18', label: 'Over 18' }],
  onQr: (qrPayload) => terminal.showQr(qrPayload),
  timeoutMs: 60_000,
})

if (result.valid) {
  bar.allowEntry()
} else {
  bar.deny(result.error)
}
```

**What the bar sees**: `valid: true`, plus the issuer's public key (a trusted government IdP). Nothing else.

**What the bar does NOT see**: name, exact age, address, document number, photo.

**Privacy properties**:

- Per-credential salt prevents linking this proof to other venues.
- The challenge is single-use — a recorded token cannot be replayed.
- The user's passkey signs the token in the secure enclave; the wallet never exports key material.

---

## 2. EU-only marketplace listing

Goal: a service operates only in the EU and needs to confirm sellers are EU residents.

```ts
const result = await verifier.requestPresentation({
  verifierName: 'EU Marketplace',
  predicates: [{ id: 'nationality:eu', label: 'EU citizenship' }],
  onQr: (payload) => listing.renderQr(payload),
})
```

The proof is a Groth16 ZK proof that the seller's nationality belongs to the
27-member `eu` dataset (`AT, BE, BG, …`) — the verifier learns _yes/no_,
never the specific country. The dataset is registered in `zk-circuits` and
served by the verification service at `GET /circuit-data/eu`; the verifier
recomputes the canonical Merkle root server-side rather than trusting any
list the holder sends.

---

## 3. Hire-only-KYC-verified contractors

Goal: a remote-work platform requires every contractor to have completed at least KYC tier 2 with any approved provider.

```ts
const result = await verifier.requestPresentation({
  verifierName: 'Acme Talent',
  predicates: [{ id: 'kycLevel2', label: 'KYC tier 2 or higher' }],
  disclose: ['firstName', 'lastName'],
  onQr: (payload) => onboarding.showQr(payload),
})

if (result.valid) {
  await onboarding.complete({
    firstName: result.subjects?.firstName,
    lastName: result.subjects?.lastName,
  })
}
```

Name comes back in plaintext (it's on the offer letter); KYC tier is a ZK predicate — the platform never sees the underlying KYC report.

---

## 4. Anti-bot signup (verified humans only)

Goal: a forum or event signup wants to confirm visitors are real humans without learning their identity.

```ts
const result = await verifier.requestPresentation({
  verifierName: 'Acme Community',
  predicates: [{ id: 'isOver13', label: 'Real human, age-appropriate' }],
  onQr: (payload) => signup.showQr(payload),
})
```

The user proves they hold a credential issued by a trusted KYC provider, plus an age threshold. The signup form learns nothing else — no email, no document, no profile data — and gets bot-resistance for free.

---

## 5. Conference / event ticketing

Goal: gate access to a paid event. Each ticket is a credential issued at purchase; holders present a single-use proof at the door without exposing the QR-code-as-bearer-token pattern that gets screenshots resold on Telegram.

**Issuance** — when someone buys a ticket, your back office mints a credential bound to a holder public key (the user's wallet, registered at checkout):

```ts
import { OwlIssuer } from '@owlid/sdk'

const issuer = new OwlIssuer({ apiKey: process.env.OWLID_API_KEY! })

const session = await issuer.startSession('owlcon-checkout')
await issuer.submitClaims(session.id, {
  eventId: 'OWLCON-2026',
  tier: 'vip',
  ticketId: ticket.id,
  validFrom: '2026-09-15T08:00:00Z',
  validUntil: '2026-09-17T22:00:00Z',
  transferable: false,
})

const credential = await issuer.issue(session.id, {
  publicKey: holderPublicKey,
  algorithm: 'p256',
})
// hand `credential.document` to the wallet
```

**At the door** — the scanner runs a QR presentation flow, asking only for `eventId`, the validity window, and (for VIP-only fast-track) the tier:

```ts
import { OwlVerifier } from '@owlid/sdk'

const verifier = new OwlVerifier({ apiKey: process.env.OWLID_DOOR_KEY! })

const result = await verifier.requestPresentation({
  verifierName: 'OwlCon 2026 Entrance',
  predicates: [
    { id: 'isThisEvent', label: 'Valid OwlCon 2026 ticket' },
    { id: 'isVip', label: 'VIP tier' },
  ],
  onQr: (payload) => scanner.showQr(payload),
  timeoutMs: 30_000,
})

if (result.valid) scanner.unlockGate()
```

**Why it beats QR-image tickets**:

- The token is single-use — the platform consumes the door's nonce on `verify()`. A screenshot replays as `valid: false`.
- The wallet signs each token with the user's passkey at scan time. A photo of the wallet screen has no signing material.
- If a ticket is refunded or charged back, the issuer revokes the credential. The door's verifier sees the change in real time via `subscribeRevocations`.
- Hidden attributes stay hidden — you can put the buyer's name on the credential for support reasons without the door scanner ever reading it.

**Per-session passes** (multi-day badge): same credential, holder generates a fresh token per scan. Each scan binds to a new door challenge — no replay window.

**Transferable tickets** (resale market): set `transferable: true` and re-issue under the new buyer's key when ownership changes. Old credential goes on the revocation registry the same instant.

---

## 6. Anonymous voting / DAO membership

Goal: prove "I'm a member of this group" without revealing _which_ member. Ring signatures attach a signature that any one of N ring keys could have produced — verifiers learn the holder is in the ring, not which one.

```ts
import { Credential, Token } from '@owlid/sdk'

const credential = Credential.fromJson(stored)
const prepared = credential.prepare(proofRequest, 3600)

const token = Token.finalizeRingSig(prepared, ownerPrivateHex, [
  ownerPublicHex,
  decoy1Hex,
  decoy2Hex,
  decoy3Hex,
])

const compact = token.toCompact() // submit to vote
```

Verifier-side:

```ts
const result = await verifier.verify(compact, ballot.challenge)
// valid: true, but no ownerKey is exposed
```

---

## 7. Stolen-device credential revocation

Goal: a user's phone is stolen. The issuer revokes the credential; subsequent verifications fail immediately and verifiers can drop cached results.

Issuer side (operator dashboard or your back office):

```ts
// admin tooling — not part of the public SDK
// (revokes by credential rootHash via the OwlID admin API)
```

Verifier side, optional live invalidation:

```ts
const unsubscribe = verifier.subscribeRevocations((event) => {
  cache.invalidate(event.credentialId)
})
```

Next `verify()` call returns `{ valid: false, error: 'Credential revoked' }`.

---

## 8. GDPR right-to-erasure

Goal: an EU resident exercises their right to be forgotten. Their identifying data on the platform is anonymized; cryptographic audit trails remain hash-only.

The user (or their support rep) triggers erasure from the operator dashboard. The platform:

1. Revokes every active credential bound to the holder's public key.
2. Replaces stored claim data with anonymised placeholders.
3. Retains hash-only audit records (compliance) but strips PII.
4. Returns a signed receipt the user keeps as proof.

OwlID was designed so the platform mostly stores hashes already — there's very little PII to erase. The flow exists for compliance, not because the system retains a copy of the user's documents.

---

## Common patterns

- **Render the QR full-screen** so phones don't have to crop the camera frame.
- **Use a short challenge TTL** (60 s) for unattended kiosks, longer (5 min) for online flows.
- **Cache verification results** keyed by token hash, expire on either TTL or a revocation push event.
- **Map `result.error` to user-friendly messages** — the platform returns codes like `Credential revoked`, `Token expired`, `Untrusted issuer`.
- **For mobile-only verifiers**, use `OwlVerifier.openPresentation()` plus a deep link rather than QR.
