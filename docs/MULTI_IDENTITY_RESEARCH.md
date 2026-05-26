# OwlID — Multi-Identity Research

**Date:** 2026-05-20 · **Branch:** `feat/standards-sd-jwt-vc` · **Status:** research input for the multi-credential / multi-IdP refactor.

This document is **research and recommendation only**. The companion documents [`MULTI_IDENTITY_REFACTOR_PLAN.md`](./MULTI_IDENTITY_REFACTOR_PLAN.md) and [`MULTI_IDENTITY_CARDS.md`](./MULTI_IDENTITY_CARDS.md) describe the resulting file-level plan and the UI design respectively.

The starting position (one credential per wallet, one IdP per session, one passport view) is recorded in [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`ARCHITECTURE.md`](./ARCHITECTURE.md). Read those before this.

---

## 1. Standards survey

### 1.1 Multi-credential queries — DCQL vs Presentation Exchange v2

| Property         | DCQL (OpenID4VP 1.0)                                                                                                                                                    | Presentation Exchange v2 (DIF)                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Status           | **Standardized in OpenID4VP 1.0 Final (Jul 2025)**. Mandatory query language. Replaces PE2 in the spec.                                                                 | DIF spec. Was the OpenID4VP query language until draft 22 (Oct 2024).                                  |
| Multi-credential | First-class. `credentials[]` declares each requested credential; `credential_sets[]` declares alternative combinations with `options: [["a"], ["b","c"]]` + `required`. | First-class. `input_descriptors[]` + `submission_requirements[]` (rule: pick / all_from groups).       |
| Format coverage  | `dc+sd-jwt`, `vc+sd-jwt`, `mso_mdoc`, `jwt_vc_json`, `ldp_vc`.                                                                                                          | Same family.                                                                                           |
| Claim path       | "Claims path pointer" — ordered tokens that descend into nested JSON or mdoc namespaces. Less expressive than JSON Schema, easier to evaluate.                          | JSON Schema + JSONPath. Far more expressive but heavier; pitfalls around `_sd` digests vs disclosures. |
| Adoption today   | EUDI wallet, walt.id (preferred), Mattr, Sphereon (in flight).                                                                                                          | Walt.id (legacy), Sphereon (current), Veramo. Sunsetting in OpenID4VP per the IETF/OpenID liaison.     |

**Conclusion.** DCQL is now the OpenID4VP 1.0 normative query language. PE2 is a legacy interop bridge for older RPs only. OwlID has no legacy PE2 surface to preserve — adopting DCQL alone is correct and consistent with the standards-projection principle in `ARCHITECTURE.md` §9.

OpenID4VP 1.0 §6.1 declares `credentials[]`; §6.2 declares `credential_sets[]`. Each `credential_sets` entry is `{options: <id-list-of-lists>, required: <bool>}`. A wallet that satisfies any one `options` row from each `credential_sets` entry has satisfied the request. Section 8.1 returns the matches as `vp_token`, **a JSON object keyed by the matching credential `id`s from the query** (the spec moved away from array-of-presentations in draft 22+ exactly because keyed lookup is unambiguous).

### 1.2 vp_token shape for multi-credential

OpenID4VP 1.0 §8.1 (DCQL response):

```json
{
  "vp_token": {
    "passport": "<SD-JWT VC + KB-JWT>",
    "email": "<SD-JWT VC + KB-JWT>"
  }
}
```

Each value is a **per-credential presentation** in that credential's own format. For `dc+sd-jwt` it is the full `<JWT>~<disc>~…~<KB-JWT>` string. Each KB-JWT is signed independently by that credential's `cnf` key over the same `aud`/`nonce`. No cross-credential bundling appears in the wire format.

### 1.3 Cross-credential holder binding

OpenID4VP 1.0 §6.1's `require_cryptographic_holder_binding` applies **per credential query**, not across credentials. SD-JWT VC draft 16 § 2.2.2 says nothing about cnf reuse across credentials — that is a gap.

Three patterns from the field:

| Pattern                                                            | Mechanism                                                                                                                                                                                  | Privacy posture                                                                                                                | OwlID feasibility                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| **(a) Single wallet `cnf` key reused across credentials**          | Every credential is issued to the same holder pubkey. KB-JWT proves possession.                                                                                                            | Same `cnf` value across credentials → trivial cross-verifier correlation. Worst privacy.                                       | Easy but undercuts the unlinkability already paid for by OID4VCI Batch.                     |
| **(b) Per-credential keys, bound by ZK/BBS+ key attestation**      | Each credential has its own `cnf`. A "key attestation" or BBS+ proof attests both came from the same secure element / wallet instance.                                                     | Strong: verifier learns "same wallet instance" without seeing key identifiers.                                                 | Requires either an external key-attestation chain (HAIP X.509) or BBS+ — both out of scope. |
| **(c) Per-credential keys + per-presentation linkage = the nonce** | Each credential has its own `cnf`. Each KB-JWT signs over the **same** verifier `nonce` + `aud`. "Same person" is a presentation-context fact, not a cross-presentation linkable property. | Cross-verifier unlinkable. Within one presentation the verifier sees one party prove control of both keys at the same instant. | Native to OpenID4VP and SD-JWT VC. No new cryptography.                                     |

**EUDI reference wallet** chose (c) with per-credential keys minted in Android Keystore + a `Document` envelope to group batch siblings ([`wallet-core/.../document/DocumentExtensions.kt`](https://github.com/eu-digital-identity-wallet/eudi-app-android-wallet-core)). **Walt.id wallet** mostly does (a) (one DID, many VCs) but is in the process of moving to per-credential keys for OID4VP. **Sphereon SSI SDK** is per-credential by virtue of being a Veramo plugin — keys are KMS objects independent of credentials. **Microsoft Entra Verified ID** follows (a) but with PRF-derived per-verifier pseudonyms (proprietary).

**For OwlID** (c) is the only option compatible with the Midnight-only constraint and with the OID4VCI Batch unlinkability already shipped. (b) would force BBS+ or HAIP X.509, both explicitly out of scope per `ARCHITECTURE.md` §9.

### 1.4 Multi-credential privacy leak

Even with (c), a single presentation that draws claims from credential A and credential B leaks "the holder of A is the same as the holder of B" to that verifier. This is a fact of context, not a cryptographic correlation — it is exactly what the user is consenting to disclose by presenting both. It is **not** a cross-verifier correlation: a second verifier sees neither presentation, and OID4VCI Batch credentials of A and B will be different on the next presentation.

EUDI's mitigation is to surface the linkage explicitly in the holder UI ("the verifier will learn these two cards belong to the same wallet") and to make multi-credential presentations a deliberate user gesture, not an automatic optimization. Microsoft Entra mints per-verifier pseudonyms (PRF chain) to hide this. The PE2 / DCQL world has nothing better.

**Recommendation:** show the user the linkage in the consent dialog. Do not invent custom unlinkability cryptography on top — that is the BBS+/HAIP path explicitly out of scope.

---

## 2. Existing-system benchmark

The full benchmark including file-level references is in the research worksheet; the salient cells:

| Aspect                   | Walt.id                                                       | Sphereon SSI-SDK                                                           | EUDI reference wallet                                                                                            |
| ------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Store                    | `credentials` table, composite PK `(wallet, id)`, format col. | Plugin `credential-store`, filter-based `UniqueDigitalCredential` records. | `DocumentManager` of `IssuedDocument`s; each is a batch envelope (`credentialsCount`, `OneTimeUse`/`RotateUse`). |
| Query language           | DCQL **and** PE v1/v2 (DCQL preferred via `waltid-dcql`).     | PE v1/v2 only. DCQL absent — notable gap.                                  | DCQL only (`transfer/openId4vp/dcql/`).                                                                          |
| Multi-credential support | Yes (DCQL `credential_sets`).                                 | Yes (PE2 `submission_requirements`).                                       | Yes (DCQL).                                                                                                      |
| Multi-IdP                | `wallet_issuers` table, first-class.                          | `contact-manager` (issuers as Contacts).                                   | Multi-document store, batch + multi-issuer first-class in ARF.                                                   |
| Holder binding           | One DID / one key per wallet, many credentials per key.       | Per-credential keys via KMS.                                               | **Per-credential keys**, Android Keystore, hardware attestation. Batch-policy controlled.                        |
| UI                       | Wallet-of-cards (credentials, categories, issuers).           | No UI (SDK only).                                                          | Wallet-of-cards (`dashboard-feature/.../documents`).                                                             |

**Cross-cutting:** all three converge on (a) a flat array of credentials, (b) format-polymorphic rows, (c) issuers as first-class entities, (d) "wallet of cards" UI. They diverge on (a) PE2 vs DCQL and (b) shared key vs per-credential key.

**Best-fit for OwlID:** EUDI's per-credential key + document-envelope model + walt.id's relational schema + DCQL. Skip Sphereon's PE-only pattern.

---

## 3. Format / interop conclusions

### 3.1 SD-JWT VC stays as the single credential format

`ARCHITECTURE.md` §9 already commits to SD-JWT VC only under the Midnight-only constraint. Multi-credential composition does not change this calculus:

- DCQL supports SD-JWT VC natively (format = `dc+sd-jwt`).
- Multi-credential vp_token is per-credential, format-tagged — different rows can be different formats but we have no reason to add a second format.
- mdoc is genuinely separate code-paths (CBOR/COSE/SessionTranscript). Not in scope.
- W3C VC 2.0 + JSON-LD + `eddsa-rdfc-2022` is a second wire format and adds parallel cryptography. Not in scope.

### 3.2 SD-JWT VC Key Attestation is not load-bearing for OwlID

The "key attestation" terminology bridges two distinct drafts:

1. `draft-ietf-oauth-attestation-based-client-auth` — proof a client app was attested by its app store.
2. EUDI HAIP profile of SD-JWT VC — issuer requires a `key_attestation` JWT proving the cnf key originated in a certified WSCD (Wallet Secure Cryptographic Device).

Both rest on an external certification regime (CA chain or Trusted List). `ARCHITECTURE.md` §9 already documents HAIP / eIDAS LoA-high / Federation / Trusted Lists as unreachable under Midnight-only.

Without a certified WSCD, OwlID's holder key (Ed25519 / P-256, PRF-wrapped by a WebAuthn passkey) cannot produce a HAIP-conformant key attestation. The platform-level WebAuthn attestation is hardware-backed but not the certified WSCD attestation HAIP expects. This is a known gap, documented in `ARCHITECTURE.md` §9, and unchanged by the multi-credential refactor.

### 3.3 mdoc bridges, HAIP combined-format, and the EUDI ARF

EUDI wallets are expected to carry both mdoc and SD-JWT VC documents (ARF v1.4+). The bridge is at the DCQL layer: a single DCQL query can ask for `mso_mdoc` AND `dc+sd-jwt` and the wallet returns a mixed `vp_token` map. Reading EUDI's source confirms each credential is presented in its own format; there is no "bridge" wire format. OwlID does not ship mdoc; multi-credential is therefore SD-JWT VC homogeneous.

---

## 4. Midnight-specific considerations

### 4.1 Attestation key composition is trivially multi-credential

Today the Compact `predicate_registry` records an attestation under
`key = SHA-256(tag ‖ credential_id ‖ paramLE)`
(see `crates/proof-system/src/attestation.rs`). The verifier recomputes the key per credential. A multi-credential vp_token therefore yields N independent lookups, each keyed on its own `credential_id`. **No Compact change is required for cross-credential predicate composition.** The verifier's `check_predicate_attested` loop just iterates over the credentials inside the vp_token instead of one.

This matches `PREDICATES_AUDIT.md` §5: "the attestation key is keyed on `credential_id`, not on the witness or any per-session value." That property is what makes multi-credential composition cheap.

### 4.2 Personhood across providers

A user with a Didit credential and a Google credential has two `personhood_secret`s (HKDF derived from `national_id` and `sub` respectively). For sybil resistance:

- The same provider re-issuing → same secret → same nullifier → idempotent (intended).
- Two different providers → two distinct secrets → two distinct nullifiers in the same `(epoch, app_id)` scope. Per `PREDICATES_AUDIT.md` §8.4 this is **the expected behaviour**; nothing forces a single canonical personhood across providers, and contriving one would require an out-of-band correlation step that violates the privacy model.

Verifiers that want strong sybil resistance can ask for `unique_personhood` proofs from each of N providers; the user proves N independent personhoods, and collision across users requires colluding across multiple IdPs. That is a stronger sybil property than a single-provider personhood, not a weaker one. **No design change is needed.**

### 4.3 Sidecar witness multiplexing

The midnight-sidecar `PredicatePending` request-scoped binding (Bun + Hono, packages/midnight-sidecar/src/witnesses.ts) is currently serialized by a mutex around its private-state LevelDB. A multi-credential proof generation in one presentation = N sequential attest txs. Today's measured per-attest cost is ~30 s on the local devnet (proof gen + submit + confirm). For a 2-credential composed presentation this is ~60 s — within the existing `MIDNIGHT_SIDECAR_TIMEOUT=120` envelope but uncomfortable.

Options:

1. **Status quo** — serial attestation. Acceptable for the immediate refactor; concurrent attestation is a hot path optimization later.
2. **Batched attest circuit** — a Compact circuit that records N (key, witness) entries in one tx. Saves one round-trip's confirmation latency per credential, not the proof-gen cost. Marginal improvement, new circuit surface, deferrable.
3. **Pre-attest on issuance** — for predicates derivable from issuer-asserted claims (most of them), the issuer can publish the attestation at issuance time, and the holder presentation skips the per-presentation attest. Already the implicit model for `attestEmailVerified`. Generalizes cleanly.

**Recommendation:** ship serial attestation (1) for the multi-credential refactor; revisit (3) for predicates that don't need per-presentation freshness.

---

## 5. Recommendation

**Adopt the EUDI pattern, projected through OwlID's Midnight-only constraint.**

1. **Wallet store is a list of credentials**, not a single envelope. Composite key `(walletId, credentialId)`. Each row carries `{ sdJwtVc, issuer, credentialId, providerId, issuedAt, holderPublicKeyHex, holderKeyWrappedRef, verifiedClaims, cardShape, batchSiblings? }`.

2. **One holder key per credential**, PRF-wrapped by the wallet's single WebAuthn passkey (the passkey is the unlock gate; it doesn't sign KB-JWTs). The existing single-key store collapses to a per-credential key map.

3. **DCQL is the only query language.** Skip PE2; nothing legacy to preserve. `OwlVerifier` mints DCQL queries; `OwlWallet` matches them.

4. **Multi-credential vp_token** as defined by OpenID4VP 1.0 §8.1 (object keyed by DCQL id). Each KB-JWT signs the same `aud` + `nonce` with its own credential's `cnf` key. Cross-credential same-person is contextual (pattern (c) above), not cryptographic — exactly as EUDI ships.

5. **Per-IdP card UI.** `/wallet` lists cards. Card shape per provider: Didit / Mock-DigiD = passport, Google = account card, Apple = Apple ID card, OIDC = generic card. `/create-identity` becomes "Add provider" and appends to the wallet. Old `/passport` redirects.

6. **No Compact change** for cross-credential predicate composition; the existing `credential_id`-keyed attestation key compose naturally. **No Compact change** for per-provider personhood; multiple providers = multiple `personhood_secret`s, which is the correct model.

7. **Consent UX surfaces linkage**: when a presentation draws claims from two credentials, the consent dialog says so plainly. ("The verifier will learn that your Didit passport and your Google account belong to the same wallet.")

8. **Holder app keeps the single passkey**, not one per credential. Multi-credential is a refactor of the credential layer, not the unlock layer.

Trade-offs accepted by this recommendation:

- **No cryptographic same-person proof across credentials.** Two credentials linked in one presentation are linked to that verifier, by construction. Mitigated by (a) OID4VCI Batch one-shot credentials so the same pairing is not seen by a second verifier, (b) explicit consent in the UI. The BBS+/HAIP path that would make this cryptographically unlinkable is out of scope.
- **Per-provider personhood, not canonical.** The user has multiple personhood nullifiers. Strong sybil resistance composes; canonical-single-personhood would require trust in a single root provider, which contradicts multi-IdP.
- **Sequential per-credential proving on the sidecar.** A 2-credential composed presentation may take ~60 s today on the local devnet. Production-deploy DUST + proof-server tuning closes this; we do not redesign for it.

**Defensible alternatives explicitly rejected:**

- **Shared wallet key across credentials.** Walt.id's default. Worst-of-both: gives up the OID4VCI Batch unlinkability already paid for, and adds nothing structural in return.
- **PE2 + DCQL dual stack.** Sphereon's path. We have no PE2 verifiers to support; carrying two query languages is pure complexity.
- **`did:midnight` for the holder.** No published spec (per `ARCHITECTURE.md` §9). Defer.
- **Cross-credential key attestation (BBS+ / HAIP X.509).** Out of scope per `ARCHITECTURE.md` §9. No external trust infra to attest against.

---

## 6. Non-goals

The refactor explicitly does **not** ship the following. Each is listed here so a later reader knows it was considered and rejected with reasons, not forgotten.

- **mdoc / ISO 18013-5 documents in the wallet.** Different wire format, different proximity protocol, no Midnight projection. Out of scope per `ARCHITECTURE.md` §9.
- **W3C VC 2.0 + JSON-LD VCDM in the wallet.** A second credential format. Skipped — SD-JWT VC is the chosen single format.
- **BBS-2023 unlinkable presentations.** Heavier crypto for a strictly weaker user-visible guarantee under Midnight-only (per `ARCHITECTURE.md` §9). The multi-credential refactor does not change the calculus.
- **HAIP-conformant `key_attestation`.** Requires external CA / Trusted List. `ARCHITECTURE.md` §9 marks this out of scope.
- **OpenID Federation between wallets and verifiers.** Same external-trust-hierarchy blocker as above.
- **EUDI ARF LoA-high certification.** Regulatory third-party regime. Out of scope.
- **`did:midnight` holder identifier.** No spec, no resolver driver, no W3C method-registry entry. `ARCHITECTURE.md` §9 marks this deferred.
- **Cross-credential cryptographic same-person proof.** The OpenID4VP / SD-JWT VC stack does not provide one and the candidate techniques (BBS+ ZK proofs, key attestation chains) are out of scope. Contextual same-person via shared nonce + aud is what we ship.
- **Cross-provider canonical personhood.** Would require a single root personhood provider; contradicts multi-IdP. Per-provider nullifiers compose into stronger sybil resistance instead.
- **Presentation Exchange v2.** Sunsetting in OpenID4VP. No legacy OwlID surface to preserve.
- **Server-side wallet.** Walt.id's model; OwlID's wallet is client-side per `ARCHITECTURE.md` §9 ("`@owlid/sdk` is pure client-side; sidecar is internal-only").

---

## Sources

- OpenID4VP 1.0 Final (Jul 2025): <https://openid.net/specs/openid-4-verifiable-presentations-1_0.html>
- DCQL Draft 24 reference: <https://openid.net/specs/openid-4-verifiable-presentations-1_0-24.html>
- DCQL overview (iGrant.io): <https://docs.igrant.io/docs/dcql-overview/>
- SD-JWT VC draft 16 (Apr 2026): <https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/>
- Walt.id Identity: <https://github.com/walt-id/waltid-identity>
- Sphereon SSI SDK: <https://github.com/Sphereon-Opensource/SSI-SDK>
- EUDI reference wallet (Android): <https://github.com/eu-digital-identity-wallet/eudi-app-android-wallet-ui>
- EUDI wallet core: <https://github.com/eu-digital-identity-wallet/eudi-lib-android-wallet-core>
- DCQL Playground: <https://dcqlfiddle.com/>
- Spruce ID OpenID4VP DeepWiki: <https://deepwiki.com/spruceid/openid4vp/2.7-dcql-queries>
