# OwlID — Per-IdP Wallet Cards

**Date:** 2026-05-20 · **Companion to:** [`MULTI_IDENTITY_RESEARCH.md`](./MULTI_IDENTITY_RESEARCH.md), [`MULTI_IDENTITY_REFACTOR_PLAN.md`](./MULTI_IDENTITY_REFACTOR_PLAN.md).

This document specifies the UI for each per-IdP card in the multi-credential wallet. One `CardShape` variant per provider family. The wallet's `/wallet` route renders a vertical stack of these cards; each card opens to a detail view at `/wallet/$credId`.

Mockups are ASCII for fidelity; the real surface is React (`packages/app/src/components/cards/*`) using the existing Tailwind tokens. The list view favours density (3-line summary per card); the detail view shows the full claim set + a "Use in presentation" affordance.

The rendering rule is `cardShape.kind`-driven: the same `WalletCredential` row produces a different visual presentation depending on which IdP issued it. This is what gives the holder app its "wallet of cards" feel instead of one passport per IdP.

---

## 1. Shared anatomy

Every card has:

- **Identity line** — the IdP's display name + a one-glance status (Active / Expiring / Revoked / Batch sibling).
- **Headline value** — the most distinctive verified fact (full name for passport, primary email for Google, sub/relay-id for Apple, organisation for OIDC).
- **Claim count** — `"7 verified claims"` so the holder knows the card has substance without listing everything.
- **Predicate badges** — at-a-glance pills showing what the card can prove (`age ≥ 18`, `email verified`, `EU resident`, `KYC high`).

The detail view adds:

- **Full claim list** — grouped by sensitivity (basic / identity / sensitive).
- **Provable predicates** — every predicate this card can answer privately, with a per-predicate "explain what the verifier learns" tooltip.
- **Batch siblings** — how many one-time-use copies remain (relevant only when issued via OID4VCI Batch).
- **Issuer detail** — the `did:web` URL + the issuer's display name, plus the Midnight `identity_registry` anchor status.
- **Action row** — _Use in presentation_, _Re-issue_, _Remove from wallet_.

The cross-credential linkage banner (Research §1.4) lives in `PresentationModal`, not on the card itself.

---

## 2. PassportCard — Didit + Mock-DigiD + future ICAO-style providers

These providers attest a document scan + liveness + face-match (Didit) or a government-anchored ID record (DigiD / BankID). The card mirrors a real passport's data page.

`cardShape: { kind: 'passport', portraitImage?: string }`

**Claims rendered:** `firstName`, `lastName`, `birthDate`, `birthPlace`, `nationality`, `documentType`, `documentNumber`, `issuingCountry`, `documentExpiry`, `isResident` (if vouched).

**Predicate badges (from `PREDICATES_AUDIT.md` §7):** `age ≥ 18`, `nationality ∈ EU`, `KYC ≥ high` (Didit only) / `KYC ≥ medium` (DigiD), `residency` (where attested).

### 2.1 List view

```
┌─────────────────────────────────────────────────────────────┐
│  [photo]   Didit Passport                          Active   │
│           Jane Q. Citizen                                   │
│           Netherlands · Passport · expires 2034-08-12       │
│  ┌──────────────┬──────────────┬───────────────────────┐    │
│  │ age ≥ 18 ✓   │ EU resident ✓│ KYC ≥ high ✓          │    │
│  └──────────────┴──────────────┴───────────────────────┘    │
│                                          12 verified claims │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Detail view (abbreviated)

```
┌─ Didit Passport ────────────────────────────── [Use] [Re-issue] [Remove] ─┐
│                                                                            │
│   ┌────────┐                                                               │
│   │ photo  │   JANE Q. CITIZEN                                             │
│   │        │   Netherlands · 1990-05-12                                    │
│   └────────┘   Passport · NL  · NLA0123456                                 │
│                Expires 2034-08-12 · Issued 2024-08-12                      │
│                                                                            │
│   Identity                                                                 │
│   ── given_name        Jane                                                │
│   ── family_name       Q. Citizen                                          │
│   ── birthdate         1990-05-12                                          │
│   ── nationalities     [NL]                                                │
│   ── address           {locality: Amsterdam, country: NL, …}               │
│                                                                            │
│   Provable (without disclosing source claim)                               │
│   ── age_over_18         age ≥ 18                                          │
│   ── nationality_in_eu   nationality ∈ EU                                  │
│   ── kyc_level           ≥ high                                            │
│   ── resident            true                                              │
│                                                                            │
│   Issuer:  did:web:issuer.owlid.dev    on-chain anchor ✓                   │
│   Batch:   4 of 8 one-time copies remaining                                │
└────────────────────────────────────────────────────────────────────────────┘
```

The portrait image is rendered locally from `verifiedClaims.portraitImage` — it never travels to the verifier.

### 2.3 Why this shape

Didit and Mock-DigiD vouch for document-grade identity, so the user's expectation is "this is my passport in digital form." The card layout mirrors that. The existing `PassportDataPage` component in `packages/app/src/components/` becomes the implementation of `PassportCard`; the move is a refactor, not a rewrite.

---

## 3. GoogleAccountCard — Google OIDC

Google's eIDAS assurance is `Low` (`PREDICATES_AUDIT.md` §7) — no document, no liveness. The card emphasises account-ness: which Google account, which Workspace organisation, whether the email is verified.

`cardShape: { kind: 'google-account', hd?: string }` where `hd` is Google's "hosted domain" claim (Workspace org).

**Claims rendered:** `email`, `email_verified`, `name`, `picture` (avatar URL, local cache), `locale`, `hd` (Workspace org), `sub` (display only — never to verifiers).

**Predicate badges:** `email_verified`, `workspace_org ∈ {…}` (when `hd` is set), `unique_personhood` (per-provider scope).

### 3.1 List view

```
┌─────────────────────────────────────────────────────────────┐
│  [G]   Google Account                              Active   │
│        jane.citizen@example.com                             │
│        Workspace · example.com                              │
│  ┌──────────────────┬──────────────────────────────────┐    │
│  │ email verified ✓ │ workspace org ✓                  │    │
│  └──────────────────┴──────────────────────────────────┘    │
│                                            4 verified claims│
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Detail view

```
┌─ Google Account ─────────────────────────────── [Use] [Re-issue] [Remove] ┐
│                                                                            │
│   ┌──────┐   jane.citizen@example.com  ✓ verified                          │
│   │  G   │   Jane Citizen · en-US                                          │
│   └──────┘   Workspace organisation: example.com                           │
│                                                                            │
│   Account claims                                                           │
│   ── email             jane.citizen@example.com                            │
│   ── email_verified    true                                                │
│   ── name              Jane Citizen                                        │
│   ── locale            en-US                                               │
│   ── hd                example.com                                         │
│                                                                            │
│   Provable                                                                 │
│   ── email_verified         email is verified by Google                    │
│   ── workspace_org_in_set   organisation ∈ <verifier's allow-list>         │
│   ── unique_personhood      one-of-one per app/epoch (Google scope)        │
│                                                                            │
│   Issuer:  did:web:issuer.owlid.dev    on-chain anchor ✓                   │
│   Note:    Google assurance = Low.  Use for email/org/sybil flows;         │
│            not for AML/age-gated flows.                                    │
└────────────────────────────────────────────────────────────────────────────┘
```

The "assurance = Low" note is editorial copy; it makes the limitation visible to the holder without burying it in docs.

### 3.3 Why this shape

The holder thinks of "their Google account," not "their Google passport." The card matches that mental model. The Workspace `hd` claim gets its own line because corporate verifiers care about it more than they care about `sub`.

---

## 4. AppleIdCard — Apple Sign In

Apple's Sign in with Apple OIDC is similar in posture to Google (no document) but introduces the **private email relay**: the holder may have given the verifier `…@privaterelay.appleid.com` instead of their real email. The card surfaces this.

`cardShape: { kind: 'apple-id', relayEmail?: boolean }`.

**Claims rendered:** `email`, `email_verified`, `name`, `sub`, `is_private_email`.

**Predicate badges:** `email_verified`, `unique_personhood` (per-provider scope). `email_domain_in_set` is rarely useful (the domain is `privaterelay.appleid.com` half the time).

### 4.1 List view

```
┌─────────────────────────────────────────────────────────────┐
│  [⚑]   Apple ID                                    Active   │
│        jane@privaterelay.appleid.com   ⚑ private relay      │
│        Apple verifies; relay hides your real email          │
│  ┌──────────────────┬──────────────────────────────────┐    │
│  │ email verified ✓ │ private relay ⚑                  │    │
│  └──────────────────┴──────────────────────────────────┘    │
│                                            3 verified claims│
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Detail view

```
┌─ Apple ID ─────────────────────────────────── [Use] [Re-issue] [Remove] ──┐
│                                                                            │
│   ┌──────┐   Jane Citizen                                                  │
│   │  ⚑   │   jane@privaterelay.appleid.com                                 │
│   └──────┘   Apple stable subject identifier · iCloud account              │
│                                                                            │
│   Account claims                                                           │
│   ── email             jane@privaterelay.appleid.com                       │
│   ── email_verified    true                                                │
│   ── is_private_email  true                                                │
│   ── name              Jane Citizen                                        │
│                                                                            │
│   Provable                                                                 │
│   ── email_verified         email is verified by Apple                     │
│   ── unique_personhood      one-of-one per app/epoch (Apple scope)         │
│                                                                            │
│   Issuer:  did:web:issuer.owlid.dev    on-chain anchor ✓                   │
│   Note:    Private relay — if revealed, this email forwards to your real   │
│            inbox.  No real email is disclosed to verifiers.                │
└────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Why this shape

The relay flag is the only Apple-specific UX consideration that a verifier or holder might miss. Surfacing it inline (chip on the list view, explainer in the detail) defuses the "is this email real?" question.

---

## 5. GenericOidcCard — Microsoft, custom OIDC providers

Anything coming through the generic OIDC adaptor (Microsoft, Okta, custom enterprise IdP, future EUDI-PID OIDC profile) renders through this fallback. The card carries a brand line + logo if the provider config supplies one.

`cardShape: { kind: 'generic-oidc', logoUrl?: string, brandName: string }`.

**Claims rendered:** whatever the provider attests (typically `email`, `name`, `preferred_username`, `org`, `roles`).

**Predicate badges:** dynamically derived from the available claims via the provider's normalize() output.

### 5.1 List view

```
┌─────────────────────────────────────────────────────────────┐
│  [🪟]   Microsoft Entra                            Active   │
│        jane@example.onmicrosoft.com                         │
│        Roles: developer, billing                            │
│  ┌──────────────────┬──────────────────────────────────┐    │
│  │ email verified ✓ │ org ∈ example                    │    │
│  └──────────────────┴──────────────────────────────────┘    │
│                                            5 verified claims│
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Detail view

```
┌─ Microsoft Entra ────────────────────────────── [Use] [Re-issue] [Remove] ┐
│                                                                            │
│   ┌──────┐   Jane Citizen                                                  │
│   │  🪟  │   jane@example.onmicrosoft.com                                  │
│   └──────┘   example.onmicrosoft.com · roles: developer, billing           │
│                                                                            │
│   Claims                                                                   │
│   ── email                 jane@example.onmicrosoft.com                    │
│   ── email_verified        true                                            │
│   ── preferred_username    jcitizen                                        │
│   ── org                   example.onmicrosoft.com                         │
│   ── roles                 [developer, billing]                            │
│                                                                            │
│   Provable                                                                 │
│   ── email_verified         email is verified by the IdP                   │
│   ── org_in_set             org ∈ <verifier's allow-list>                  │
│   ── role_contains          roles include <required role>                  │
│                                                                            │
│   Issuer:  did:web:issuer.owlid.dev    on-chain anchor ✓                   │
└────────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Why this shape

The OIDC providers each have a slightly different vocabulary (Microsoft `oid`, Okta `sub`, custom `employee_id`); rather than ship a card per provider we ship one fallback whose chrome is brand-customisable. `brandName` defaults to the provider id (`microsoft`, `okta`, …) and the logo is the IdP-supplied SVG. The claim list is rendered by iterating `verifiedClaims` because the schema is provider-specific.

---

## 6. Card-resolver decision table

```
provider.id        → cardShape.kind     → component
─────────────────────────────────────────────────────────────
'didit'            → 'passport'         → PassportCard
'mock-digid'       → 'passport'         → PassportCard
'mock-bankid'      → 'passport'         → PassportCard
'google'           → 'google-account'   → GoogleAccountCard
'apple'            → 'apple-id'         → AppleIdCard
'oidc' / 'oidc-*'  → 'generic-oidc'     → GenericOidcCard
…anything else…    → 'generic-oidc'     → GenericOidcCard
```

`packages/app/src/components/cards/CardRenderer.tsx` is a one-screen switch on `credential.cardShape.kind`. Provider id is captured at issuance and stored in `WalletCredential.providerId` so the resolver does not have to re-parse the SD-JWT VC `iss`.

---

## 7. Empty state and add-provider flow

When `storage.listCredentials()` is empty, `/wallet` renders the empty state:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│                 Your wallet is empty                        │
│                                                             │
│      Add a provider to get a verifiable credential          │
│                                                             │
│            ┌─────────────────────────────────┐              │
│            │   +  Add provider               │              │
│            └─────────────────────────────────┘              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

`+ Add provider` routes to `/add-provider`, which lists every entry in the issuer's `ProviderRegistry` (Didit, Google, Apple, Microsoft, Mock-DigiD, …). Selecting one opens that provider's flow (existing form / OIDC redirect / QR — `mapStart` in `packages/sdk/src/issuer.ts:266`). On completion, the new credential is **appended** to the wallet — the old single-cred "redirect to /passport when a credential exists" guard (today `_identity/create-identity.tsx:12-28`) is removed.

The same `/add-provider` route is reachable from the wallet's "+" button on any non-empty wallet — adding a second or third provider is a normal action, not a re-bootstrap.

---

## 8. Card states (status pill)

| State           | When                                                                          | Pill colour / label    |
| --------------- | ----------------------------------------------------------------------------- | ---------------------- |
| Active          | Credential not revoked, not expired, batch siblings ≥ 1.                      | Green · `Active`       |
| Expiring        | `exp` claim within 30 days.                                                   | Amber · `Expires soon` |
| Expired         | `exp` claim in the past.                                                      | Grey · `Expired`       |
| Revoked         | Verification service `/status-revoked` reports the `credentialId` as revoked. | Red · `Revoked`        |
| Batch exhausted | Issued via OID4VCI Batch, all siblings consumed.                              | Amber · `Re-issue`     |
| Pending         | Issuance in-flight (provider session pending).                                | Grey · `Pending`       |

Wallet poll (TanStack Query):

```ts
useQuery({
  queryKey: ['wallet', 'statuses'],
  queryFn: () => verifier.bulkStatus(credentials.map((c) => c.credentialId)),
  refetchInterval: 60_000,
})
```

`verifier.bulkStatus` is a one-shot multi-id revocation lookup served by the verification service (`POST /revocations/status` — additive route, lives under the `revocations` tag).

---

## 9. Use-in-presentation affordance

Every card detail has a `Use` button. The interaction is _not_ "send this card to a verifier" — it is "make this card the preferred choice when an open DCQL request can be satisfied by multiple cards."

Flow:

1. Verifier opens a presentation session.
2. Holder app receives the DCQL request over WS.
3. The wallet's matcher finds N candidate credentials per DCQL query.
4. Default selection: newest issuance per query that also has the predicates the verifier asks for.
5. The user can override per-query: tap a card → "Use this card for `age ≥ 18`" → wallet swaps the candidate for that DCQL id.
6. `PresentationModal` shows the linkage banner if > 1 distinct credential is being used, then proceeds on consent.

The override interaction is what makes the per-IdP card UI meaningful — the user sees that the wallet _chose_ a card and can change it.
