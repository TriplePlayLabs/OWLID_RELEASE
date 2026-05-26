# OwlID — Multi-Identity Refactor Plan

**Date:** 2026-05-20 · **Branch:** `feat/standards-sd-jwt-vc` (work follows in a separate branch) · **Status:** plan only, no code yet.

Companion to [`MULTI_IDENTITY_RESEARCH.md`](./MULTI_IDENTITY_RESEARCH.md) (the why) and [`MULTI_IDENTITY_CARDS.md`](./MULTI_IDENTITY_CARDS.md) (the per-IdP card UI).

The plan is **file-level, not line-level**: it names the modules that change, the types that change, and the directionally-correct shape of the new APIs. Exact field naming and exact route signatures are settled when implementing each section.

The hard non-negotiables from `~/.claude/CLAUDE.md` apply throughout: bun (not npm); no AI attribution; never delete user work; never half-finish; generated API clients are auto-generated (`just generate-api-client`); minimum-viable comments. The Midnight-only / SD-JWT-VC-only / DCQL-only / contextual-cross-cred-binding posture from the research is assumed; do not reopen those decisions here.

---

## 1. Data model

### 1.1 Holder-side storage (`packages/sdk/src/storage.ts`)

Today (lines 132-146): scalar keys `owl_proof_credential`, `owl_holder_key`, `owl_owner_public_key`, `owl_verified_claims`, `owl_idp_session_id`. One credential per wallet.

Refactor to a credential list keyed by `credentialId`, plus a stable wallet identity.

New types (replace `Credential` + `StoredCredentialData`):

```ts
// packages/sdk/src/storage.ts
export interface WalletCredential {
  credentialId: string // base64url(sha-256(issuer JWT))
  sdJwtVc: string // application/dc+sd-jwt
  issuer: string // did:web URL (the SD-JWT `iss`)
  providerId: string // 'didit' | 'google' | 'mock-digid' | …
  issuedAt: string // ISO timestamp
  expiresAt?: string // ISO, when SD-JWT `exp` is set
  cardShape: CardShape // see §1.2
  verifiedClaims: VerifiedClaims // unhashed disclosures, local-only
  holderPublicKeyHex: string // per-credential cnf pubkey (hex)
  holderKeyWrappedRef: string // storage key for the PRF-wrapped seed
  batchSiblings?: string[] // other credentialIds in the same OID4VCI Batch
}

export type CardShape =
  | { kind: 'passport'; portraitImage?: string } // Didit, Mock-DigiD, future ICAO
  | { kind: 'google-account'; hd?: string } // Google OIDC (hd = workspace hint)
  | { kind: 'apple-id'; relayEmail?: boolean } // Apple Sign In
  | { kind: 'generic-oidc'; logoUrl?: string; brandName: string } // Microsoft, custom OIDC
```

Storage layout (new keys):

```
owl_wallet_index            // JSON array of credentialIds, oldest-first
owl_wallet_cred:<credId>    // serialized WalletCredential (without the holderKeyWrapped blob)
owl_wallet_key:<credId>     // the PRF-wrapped Ed25519/P-256 seed blob
owl_wallet_passkey          // (was owl_webauthn_credential — passkey is wallet-global, kept singular)
```

Methods on `CredentialStorageManager`:

| Today (delete after migration) | New                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `saveCredentialData(d)`        | `addCredential(c: WalletCredential, wrappedKey: string): Promise<void>`                                  |
| `loadCredentialData()`         | `listCredentials(): Promise<WalletCredential[]>` + `getCredential(id): Promise<WalletCredential ⏐ null>` |
| `hasStoredCredential()`        | `hasAnyCredential(): Promise<boolean>` (true if `owl_wallet_index` is non-empty)                         |
| `saveHolderKey(blob, pub)`     | folded into `addCredential` (key blob is `owl_wallet_key:<credId>`)                                      |
| `getHolderKeyWrapped()`        | `getCredentialKeyWrapped(credId): Promise<string ⏐ null>`                                                |
| `getStoredCredential()`        | drop (replaced by `listCredentials` + selector)                                                          |
| `getStoredClaims()`            | folded into `getCredential(id).verifiedClaims`                                                           |

`clearAll()` keeps working (iterates `STORAGE_KEYS` + the per-cred prefix). `removeCredential(id)` is new.

The legacy `IdentityData` blob (`owl_encrypted_identity`) and `saveEncryptedIdentity` / `decryptIdentity` (storage.ts:332-357) are retired — they were the single-passport flat form. The wallet now derives display data from each credential's `verifiedClaims` + `cardShape`.

### 1.2 Issuer-service DB (`crates/issuer-service/migrations/`)

The `issued_credentials` table (migration 001) already keys on `owner_public_key`. With per-credential keys this becomes a one-row-per-credential model naturally — no schema change required. Optional cleanup: add a `provider_id` column so the issuer can report per-provider counts. Migration 006 (new).

### 1.3 Verification-service mirrors

No data-model change. Revocation cache + trusted-issuer cache are per-`credential_id` / per-issuer-key already.

---

## 2. SDK API

### 2.1 `@owlid/sdk` holder surface (`packages/sdk/src/`)

#### `holder.ts` (single-credential primitives — keep)

The existing `presentSdJwtVc(sdJwtVc, holderKeyHex, disclose, binding)` (holder.ts:45-57) is per-credential and does not change. It is the building block.

`respondToPresentation` (holder.ts:60-145) handles a single-credential consent + WS round-trip and stays as-is for backward-compatible single-cred presentations. Multi-credential gets a new top-level entry.

#### `wallet.ts` (new file — multi-credential aggregator)

```ts
// packages/sdk/src/wallet.ts

export interface DcqlRequest {
  credentials: DcqlCredentialQuery[] // OpenID4VP 1.0 §6.1 shape
  credential_sets?: DcqlCredentialSet[] // §6.2 — alternatives + required
}

export interface WalletPresentRequest {
  dcql: DcqlRequest
  aud: string // verifier identifier (KB-JWT `aud`)
  nonce: string // verifier nonce (KB-JWT `nonce`)
}

export interface WalletPresentResult {
  vp_token: Record<string, string> // {dcqlId → SD-JWT VC presentation string}
  used: Array<{ dcqlId: string; credentialId: string }> // for UI receipts
}

export class OwlWallet {
  constructor(storage: CredentialStorageManager, unwrap: UnwrapHolderKeyFn)

  /** Solve a DCQL request against the local credentials and return a vp_token map. */
  async present(req: WalletPresentRequest): Promise<WalletPresentResult>

  /** Just match the DCQL — no presentation — so the UI can show what would be disclosed. */
  match(req: DcqlRequest): Promise<DcqlMatchSummary[]>
}
```

`OwlWallet.present` enumerates `req.dcql.credentials`; for each query it picks an eligible local `WalletCredential` (newest by `issuedAt`, batch-sibling-rotating where available); unwraps the per-credential key; calls `presentSdJwtVc` with the same `aud`/`nonce` for every entry; assembles the `Record<string, string>` keyed by the DCQL query `id`. The function is purely client-side.

`credential_sets` solving is a small SAT-style enumeration. EUDI's algorithm in `wallet-core` is the reference; walt.id's `DcqlMatcher.kt` is the cleanest open code. We re-implement it in TypeScript — a few hundred lines, no new dependency.

#### `issuer.ts` (mostly unchanged)

`OwlIssuer.issue` / `issueBatch` (issuer.ts:177-217) operate per-credential, taking a `holder: Holder` argument. Multi-IdP composition lives outside the SDK — the holder app calls `startSession(providerId)` once per provider, each session issues a credential (or a batch), and the app appends to the wallet via `storage.addCredential`.

#### `verifier.ts` (additive — new method)

Today `OwlVerifier.verify(presentation, challenge, audience)` (verifier.ts:147-160) takes a single SD-JWT VC string.

Add a new method for multi-cred:

```ts
async verifyDcql(
  vpToken: Record<string, string>,
  challenge: string,
  audience: string | undefined,
  query: DcqlRequest,
): Promise<DcqlVerificationResult>
```

`DcqlVerificationResult` carries a per-DCQL-id verdict + the union of disclosed `subjects`:

```ts
export interface DcqlVerificationResult {
  valid: boolean // true ⇔ every credential validated
  perCredential: Record<string, VerificationResult> // keyed by DCQL id
  subjects: Record<string, unknown> // merged disclosed claims
  error?: string
}
```

Single-cred `verify()` stays as the simple shorthand for `verifyDcql` over a single-entry vp_token.

### 2.2 Generated clients (`packages/{issuer,verifier,admin}-client/`)

Per the global rule, never hand-edit `apis/`, `models/`, `runtime.ts`. After the new utoipa routes land on the Rust side (§3), run `just generate-api-client`. The generated TS gets the new `VerifyDcqlRequest` / `VerifyDcqlResponse` models.

`packages/sdk/src/issuer.ts:229` re-exports `@owlid/issuer-client`; that surface continues to expose the generated types.

---

## 3. Verification service (`crates/verification-service/`)

### 3.1 New route `POST /verify/dcql` (api.rs)

```rust
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct VerifyDcqlRequest {
    /// vp_token shape from OpenID4VP 1.0 §8.1 — keyed by DCQL query id.
    vp_token: HashMap<String, String>,
    /// Single nonce — bound into every KB-JWT in the bundle.
    challenge: String,
    #[serde(default)]
    audience: Option<String>,
    /// The DCQL query the wallet was answering. Used to enforce
    /// per-credential format + meta constraints + claim presence.
    query: DcqlRequest,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct VerifyDcqlResponse {
    valid: bool,
    per_credential: HashMap<String, VerifyResponse>,
    subjects: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[utoipa::path(post, path = "/verify/dcql", tag = "verification", …)]
pub async fn verify_dcql(
    State(state): State<AppState>,
    Json(req): Json<VerifyDcqlRequest>,
) -> Result<Json<VerifyDcqlResponse>, ApiError> { … }
```

Implementation:

1. **Consume the challenge exactly once** (api.rs:176-187 — `validate_server_challenge` / `consume_nonce`). The whole bundle shares the same nonce; one-shot consumption is correct.
2. For each `(dcqlId, presentation)`:
   - Resolve `iss` → did:web → trusted-issuer key (the existing `did_resolve` path, api.rs:191-200).
   - `sd_jwt::verify` with `require_kb=true`, the shared `nonce`, the shared `audience`. Each KB-JWT signs over the **same** `aud`/`nonce` but with the credential's own `cnf` key.
   - Check the disclosed claim set against the corresponding DCQL `credentials[i]` query (`claims[].path`, `claims[].values`, `meta`).
   - Cross-check revocation against the Token Status List + Midnight `revocation_registry` (the existing single-cred path).
3. **Solve `credential_sets`**: confirm the set of valid `dcqlId`s satisfies at least one `options[]` row from every `required: true` set.
4. Merge disclosed claims into a single `subjects` JSON object (per-credential namespacing on collision — `subjects[dcqlId] = {...}`).
5. Return per-credential verdicts + the overall `valid`.

The route is added to the `verification` utoipa tag → goes into the verifier-client.

### 3.2 OpenID4VP `direct_post` (api.rs:86-99)

Today `Oid4vpResponse { vp_token: String, state }` decodes vp_token as a single SD-JWT VC string. For multi-credential, `vp_token` becomes either a string (back-compat) or a JSON object. Wire shape per OpenID4VP 1.0 §8.1:

```
POST /openid4vp/response
Content-Type: application/x-www-form-urlencoded

vp_token={"passport":"<JWT>~<disc>~…~<KB>","email":"<JWT>~…"}&state=<nonce>&presentation_submission=<DCQL-echo>
```

Refactor `Oid4vpResponse` to:

```rust
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum VpTokenPayload {
    Single(String),
    Multi(HashMap<String, String>),
}

pub struct Oid4vpResponse {
    vp_token: VpTokenPayload,
    state: String,
    #[serde(default)]
    presentation_submission: Option<DcqlSubmission>,
}
```

The single-cred branch delegates to `verify_token` (unchanged). The multi-cred branch delegates to `verify_dcql`. The route URL does not change.

### 3.3 No change to `/verify` (api.rs:101-187)

Single-credential `POST /verify` stays the simple path for non-DCQL clients. A multi-credential client uses `POST /verify/dcql` (or OpenID4VP `direct_post` with a JSON `vp_token`).

### 3.4 Issuer-service routes

`/sessions/{providerId}` already takes the provider id (§1.3 above). Multi-IdP just means the holder app opens N sessions over time, one per provider, and stores N credentials.

The OpenID4VCI surface (`/credential`, `/credential` Batch) stays per-session, per-holder-key. No change to the issuer routes.

### 3.5 Tag policy (per `CLAUDE.md`)

`/verify/dcql` joins the existing `verification` tag → ends up in the verifier-client. No new tag needed; no `tags(...)` block edit; no justfile edit.

---

## 4. Compact contracts (`packages/compact-contracts/`)

**No change.**

Per `MULTI_IDENTITY_RESEARCH.md` §4.1, the existing `predicate_registry.compact` attestation key
`SHA-256(tag ‖ credential_id ‖ paramLE)`
is per-credential. Multi-credential composition is the verifier looking up N keys (one per credential in the vp_token) and intersecting with the DCQL `credentials` query. The Compact contract sees one attestation per credential, exactly as it does today.

Personhood (`attestUniquePersonhood`) does not require canonicalisation across providers — the per-provider `personhood_secret` model in `PREDICATES_AUDIT.md` §8.4 is the right behaviour for multi-IdP. Two providers = two nullifiers in the same `(epoch, app_id)` scope, by design.

Witness multiplexing in the sidecar (`packages/midnight-sidecar/src/witnesses.ts`) stays serial. Concurrent witness binding is a perf optimization deferred to a later pass — see Research §4.3.

---

## 5. Holder app (`packages/app/src/`)

### 5.1 Routes

| Today (single-cred)                                                                                                       | New (multi-cred)                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `/passport` — shows the one credential                                                                                    | `/wallet` — lists every card; `/passport` redirects (HTTP 302 inside the SPA via `beforeLoad`)               |
| `/create-identity` — one-shot bootstrap                                                                                   | `/add-provider` — appends a credential; entry point also from `/wallet`'s "+" button                         |
| `_identity/passport.tsx` `beforeLoad` (passport.tsx:14-28): redirects to `/create-identity` if no credential              | `_identity/wallet.tsx` `beforeLoad`: redirects to `/add-provider` only if `hasAnyCredential()` returns false |
| `_identity/create-identity.tsx` `beforeLoad` (create-identity.tsx:12-28): redirects to `/passport` if a credential exists | drop the redirect — adding a second provider is the normal case                                              |

`packages/app/src/routes/_identity/wallet.tsx` (new) lists `WalletCredential[]` and renders per-IdP cards (§5.2). `_identity/wallet/$credId.tsx` (new) is the credential detail screen.

### 5.2 Components

`packages/app/src/components/cards/` (new):

```
cards/
  PassportCard.tsx        // Didit + Mock-DigiD (uses verifiedClaims.portraitImage)
  GoogleAccountCard.tsx   // Google OIDC
  AppleIdCard.tsx         // Apple Sign In (relayEmail flag from cardShape)
  GenericOidcCard.tsx     // Microsoft, custom OIDC
  CardRenderer.tsx        // switches on cardShape.kind
```

`CardRenderer` is `cardShape.kind`-driven — see `MULTI_IDENTITY_CARDS.md` for each component's data + ASCII mockups.

The existing `PassportDataPage` (single-credential) is retained as the implementation of `PassportCard.tsx` — the same component, repackaged. No work is thrown away.

### 5.3 Hooks (`packages/app/src/hooks/`)

`use-idp-api.ts:107-156` (`issueAndStoreCredential`) currently overwrites the single credential. Refactor:

- Generate a fresh per-credential Ed25519 holder key (unchanged).
- Call `storage.addCredential(c, wrappedKey)` instead of overwriting.
- Build the `cardShape` from `providerId` + the verified claims:
  ```ts
  const cardShape = buildCardShape(providerId, verifiedClaims)
  ```

`use-presentation.ts:240-249` (the single-cred lookup) is replaced by an `OwlWallet` invocation:

```ts
const wallet = useOwlWallet() // wraps storage + unwrapHolderKey
const result = await wallet.present({
  dcql: request.dcql,
  aud: request.verifierName,
  nonce: request.nonce,
})
ws.send(JSON.stringify({ type: 'response', payload: result }))
```

The `request.dcql` field is the new shape the verifier service serves on the WS `request` message. If the verifier hasn't moved to DCQL yet (back-compat), `request.requestedPredicates` continues to drive a single-credential `presentSdJwtVc` call.

`use-proofs.ts:104-115` (proof generation entry) iterates the wallet's credentials and chooses the one that already has the attestation. Same routine, looped.

### 5.4 Consent UX

`packages/app/src/components/PresentationModal.tsx` adds:

- A per-card breakdown of "this verifier will see these claims from this card."
- An explicit linkage banner when the presentation draws from > 1 credential: _"The verifier will learn that your Didit passport and your Google account belong to the same wallet."_ (See Research §1.4.)
- A "Use another card" affordance per requirement so the holder can choose which credential satisfies which DCQL query.

This is a UX change, not a protocol change.

### 5.5 TanStack Query (per `CLAUDE.md` rule)

The wallet's credential list lives in `useQuery({ queryKey: ['wallet', 'credentials'], queryFn: () => storage.listCredentials() })`. Adding a provider invalidates that key; removing a credential invalidates that key. No `useState`/`useEffect` ad-hoc fetches.

---

## 6. Cross-credential holder binding

Per Research §1.3 we ship **pattern (c)**: per-credential keys, contextual same-person via shared `aud` + `nonce`.

Implementation:

1. Each `WalletCredential` carries its own `holderPublicKeyHex` + its own PRF-wrapped seed (`owl_wallet_key:<credId>`). Per-credential keys mean independent `cnf` values on the wire.
2. Every KB-JWT in a single vp_token signs over the **same** `aud` and the **same** `nonce`. The verifier confirms each KB-JWT independently. The "same person" property is presentation-context, not cryptographic.
3. The single wallet passkey gates unlocking of every per-credential key (one passkey ceremony per presentation, regardless of credential count — the PRF is invoked per key via batch deriveBits).
4. The consent UI (5.4) tells the user when this linkage is happening.

No new wire field. No `key_attestation`. No proof-of-shared-ancestor. No BBS+ derivation.

---

## 7. Migration

The holder wallet today holds at most one credential under the legacy scalar keys. The migration is a one-shot read at app boot:

```ts
async function migrateToWalletList(): Promise<void> {
  const legacy = await loadLegacyCredentialData()
  if (!legacy) return
  const cred: WalletCredential = {
    credentialId: legacy.credential.credentialId,
    sdJwtVc: legacy.credential.sdJwtVc,
    issuer: legacy.credential.issuer,
    providerId: inferProviderFromIssuer(legacy.credential.issuer),
    issuedAt: legacy.credential.issuedAt,
    cardShape: buildCardShape(/* … */),
    verifiedClaims: legacy.verifiedClaims,
    holderPublicKeyHex: legacy.holderPublicKeyHex,
    holderKeyWrappedRef: `owl_wallet_key:${legacy.credential.credentialId}`,
  }
  await storage.addCredential(cred, legacyWrappedKey)
  await clearLegacyKeys()
}
```

Run from `packages/app/src/router.tsx` startup (before any route's `beforeLoad`). Idempotent — only fires if `owl_wallet_index` is absent AND legacy `owl_proof_credential` is present.

After the migration runs once per device, the legacy keys are wiped and the wallet operates entirely on the list shape.

The Rust services do not migrate: the DB schema already supports many credentials per owner; nothing on the server side changes for existing data.

---

## 8. Open questions / deferred

| #   | Question                                                                                                                           | Default for now                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Do we support `presentation_submission` (the DCQL-echo) on the wire, or rely on `query` being re-sent?                             | Accept both. The OpenID4VP-conformant clients send `presentation_submission`.                                              |
| 2   | DCQL `meta` filters per format (e.g., issuer DID allowlist). Wire-supported but app UX implications.                               | Implement structurally; the app surfaces them in the consent UI as "this verifier only accepts cards from these issuers."  |
| 3   | Concurrent witness binding on the sidecar.                                                                                         | Serial (Research §4.3). Optimize once a 3-cred composed presentation is the common case.                                   |
| 4   | Cross-provider personhood canonicalisation.                                                                                        | Not done; per-provider nullifiers compose into stronger sybil resistance.                                                  |
| 5   | Credential delete UX. Holder removes a card → revoke server-side?                                                                  | Local delete only by default. "Also revoke at the issuer" is an opt-in second click.                                       |
| 6   | Batch siblings on multi-cred. Do we route each DCQL-id to a fresh batch sibling to preserve unlinkability across re-presentations? | Yes, when batch siblings exist — newest-unused-first. Falls back to the only credential when no siblings.                  |
| 7   | `OwlVerifier.openPresentation` QR shape — DCQL embedded in the QR vs. fetched over WS.                                             | Fetch over WS. QR stays compact; the verifier pushes the full DCQL on the `request` message.                               |
| 8   | Custom OIDC card metadata (logo, brand name). Source of truth?                                                                     | Stored client-side from `cardShape.kind === 'generic-oidc'`. Authoritative is the provider registry on the issuer service. |

None of these block the refactor.

---

## File-level diff summary

The refactor touches:

- `packages/sdk/src/storage.ts` — new types + per-cred-keyed methods, retire single-cred scalars.
- `packages/sdk/src/wallet.ts` — new file (`OwlWallet`, DCQL matcher).
- `packages/sdk/src/holder.ts` — unchanged (single-cred primitive).
- `packages/sdk/src/issuer.ts` — unchanged (per-cred issuance).
- `packages/sdk/src/verifier.ts` — new `verifyDcql` method.
- `packages/sdk/src/index.ts` — re-export `OwlWallet`, `WalletCredential`, `CardShape`, `DcqlRequest`.
- `crates/verification-service/src/api.rs` — new `verify_dcql` handler, `VerifyDcqlRequest/Response`, `Oid4vpResponse` becomes union, `peek_iss` reused.
- `crates/verification-service/src/main.rs` — register the new route; OpenAPI macro picks up the new utoipa schema.
- `crates/verification-service/src/openid4vp.rs` (or wherever the OID4VP route lives if extracted) — handle `vp_token` union.
- `crates/issuer-service/migrations/006_provider_id_column.sql` — additive, optional.
- `packages/{issuer,verifier,admin}-client/` — regenerated via `just generate-api-client`.
- `packages/app/src/routes/_identity/wallet.tsx`, `_identity/wallet/$credId.tsx`, `_identity/add-provider.tsx` — new routes.
- `packages/app/src/routes/_identity/passport.tsx` — redirect to `/wallet`.
- `packages/app/src/routes/_identity/create-identity.tsx` — drop the "redirect away if credential exists" guard; route is `/add-provider` after rename.
- `packages/app/src/components/cards/*` — new components, one per shape.
- `packages/app/src/hooks/use-idp-api.ts` — append to wallet, not overwrite.
- `packages/app/src/hooks/use-presentation.ts`, `use-proofs.ts` — multi-cred selector + `OwlWallet` invocation.
- `packages/app/src/components/PresentationModal.tsx` — per-card breakdown + linkage banner.
- `packages/app/src/router.tsx` — one-shot migration on boot.

All Compact contracts stay as-is. The Midnight sidecar stays as-is. No new top-level deps.
