# OwlID Predicate Audit

Maps every canonical privacy-preserving DI predicate to:

- whether OwlID currently attests it on-chain (`predicate_registry.compact`),
- the Compact circuit feasibility under the current toolchain (no recursion, fixed-size circuits, no floats, only `Bytes<32>` / `Uint<N>` / `MerkleTreePath` / `Set` / `HistoricMerkleTree`),
- the SD-JWT VC claim the verifier reads.

The verifier never runs a ZK verifier or hits the chain on the hot path — it consults the SSE-mirrored attestation set, exactly like the revocation registry.

---

## §1 Current state

| Predicate                | Circuit               | Witness             | Public input             | Surfaced claim       |
| ------------------------ | --------------------- | ------------------- | ------------------------ | -------------------- |
| `age >= N`               | `attestAgeGte`        | `age: Uint<16>`     | `threshold: Uint<16>`    | `age_over_N`         |
| `kyc_level >= N`         | `attestKycGte`        | `kyc: Uint<8>`      | `threshold: Uint<8>`     | `kyc_level >= N`     |
| `nationality ∈ approved` | `attestNationalityIn` | `Merkle path<5,32>` | (set anchored in ledger) | `nationality_in_set` |
| `is_resident == true`    | `attestResidency`     | `resident: Uint<8>` | (none)                   | `resident: true`     |

Attestation key = `SHA-256(pad32(tag) ‖ credential_id ‖ paramLE32)`; verifier recomputes it from the issuer-signed `credential_id` + `(tag, param)` and checks Set membership.

---

## §2 Gaps — implementables (next batch)

### 2.1 `age in [min, max]` — composite age range

**Use case:** youth programs (`age < 18 forbidden, age > 25 allowed`), senior discounts (`age in [60, 999]`), parental-consent windows.
**Witness:** `age: Uint<16>`.
**Public:** `min: Uint<16>`, `max: Uint<16>`.
**Circuit:** `assert(age >= min && age <= max)`. Param slot = `H(minLE16 ‖ maxLE16)` packed into `Bytes<32>`.
**Surfaced claim:** `age_in_range_{min}_{max}: true`.
**Feasibility:** trivial; one circuit, two range checks.

### 2.2 Sanctions-list non-membership

**Use case:** AML — prove "I am NOT on the OFAC/EU/UN sanctions list" without disclosing identity.
**Witness:** `Merkle path<D, Bytes<32>>` proving the holder's normalized identity hash is **absent** from a sanctions-list Merkle commitment, plus a co-path / range-proof for non-membership.
**Public:** sanctions-list Merkle root (seeded by owner — refreshed periodically).
**Circuit:** non-inclusion proof. Two approaches under Compact:

- **Sparse Merkle tree (SMT)**: prove the leaf slot for `H(identity)` is empty (zero-leaf). Requires SMT primitive.
- **Allow-list inversion**: maintain an `approvedNotOnSanctions` HistoricMerkleTree the issuer pre-populates with all _cleared_ identities. Holder proves inclusion. Simpler given current `MerkleTreePath` primitive.
  **Recommended impl:** allow-list inversion to match existing `attestNationalityIn` shape (same primitive).
  **Surfaced claim:** `not_sanctioned: true`.

### 2.3 PEP (Politically Exposed Person) non-membership

**Use case:** same shape as 2.2; financial onboarding requires "not a PEP".
**Witness/public:** same as 2.2 (different list root).
**Circuit:** identical to `attestNationalityIn` but with `approvedNotPep` tree + tag `pep`.
**Surfaced claim:** `not_pep: true`.

### 2.4 Unique-personhood nullifier

**Use case:** sybil-resistant airdrops, DAO voting (one human, one vote), unique-account signup.
**Witness:** `personhood_secret: Bytes<32>` (issuer-bound, persistent across all the holder's credentials).
**Public:** `epoch: Bytes<32>`, `app_id: Bytes<32>`.
**Circuit:** `nullifier = persistentHash([personhood_secret, epoch, app_id])`. `assert(!nullifiers.member(nullifier)); nullifiers.insert(nullifier);`.
**Storage:** new `nullifiers: Set<Bytes<32>>` ledger entry — separate from `attestations` because the key is per-(epoch, app) not per-credential.
**Surfaced claim:** `unique_person_in_epoch_X_app_Y: true` (read by verifier as binary).
**Privacy:** `personhood_secret` never leaves the holder; only the nullifier is on-chain. Two presentations to the same app in the same epoch collide; presentations across apps/epochs are unlinkable.

### 2.5 Generic numeric `>= threshold`

**Use case:** `income >= 50000`, `credit_score >= 700`, `net_worth >= 1_000_000`, `years_employment >= 2`.
**Witness:** `value: Uint<64>` (large enough for income in cents / credit scores / etc).
**Public:** `value_tag: Bytes<32>` (`"income"`, `"credit_score"`, `"net_worth"`, …) + `threshold: Uint<64>`.
**Circuit:** `assert(value >= threshold)`. Param = `H(value_tag ‖ thresholdLE64)`.
**Surfaced claim:** `{value_tag}_over_{threshold}: true` (e.g. `income_over_50000`).
**Feasibility:** trivial; supplants per-attribute circuits. Issuer attests once per (credential, value_tag, threshold).

---

## §3 Gaps — feasible but deferred

| Predicate                           | Use case                        | Why deferred                                                       |
| ----------------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| Residency country = X               | Geographic targeting            | Issuer can derive + emit `country: "X"` SD-JWT VC claim today.     |
| Document not expired                | Anything time-bound             | SD-JWT VC `exp` covers it natively; no circuit needed.             |
| Issuer assurance level (`loa >= N`) | eIDAS / NIST IAL ladder         | Same shape as 2.5; deferred until a real LoA-bearing IdP wired up. |
| Driving license category            | Vehicle rental                  | Same shape as 2.2 (allow-list).                                    |
| Education degree level              | Background-check                | Same shape as 2.5 (numeric ladder).                                |
| Employer in allowed set             | Corporate SSO / fleet           | Same shape as 2.2.                                                 |
| Has-license-X membership            | Regulated professions (law/med) | Same shape as 2.2.                                                 |

All seven slot into the existing primitive set; no new Compact features needed. Implementation is template work once §2 lands.

---

## §4 Out of scope under Compact-only

| Predicate                           | Why                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------- |
| Real-time bank balance              | Oracle dependency; off-chain attestor needed.                             |
| Biometric liveness                  | Live ceremony required; not a ZK circuit.                                 |
| BBS-2023 / W3C VC 2.0 multi-show    | Different signature scheme; parallel format documented elsewhere.         |
| ISO 18013-5 mdoc                    | Binary CBOR format; out of OwlID's SD-JWT VC scope per `ARCHITECTURE.md`. |
| Recursive proofs (compose circuits) | Compact has no recursion primitive yet.                                   |
| Float-precision predicates          | Compact integers only.                                                    |

---

## §5 Per-circuit privacy notes

- **Witness never leaves the holder.** All four current circuits + the §2 batch ship witnesses through holder-device `zkir-v2` WASM proving; the proven `UnboundTransaction` is witness-stripped before it hits the network.
- **No correlation across presentations.** The attestation key is keyed on `credential_id`, not on the witness or any per-session value, so revealing the attestation across N verifiers gives them nothing they could not already correlate by `credential_id`.
- **Multi-show linkability** for the _credential itself_ is defeated by **OpenID4VCI Batch Credential issuance** (`OwlIssuer.issueBatch(n)`) — each batch credential has a distinct `credential_id` and an independent attestation set entry.
- **The unique-personhood nullifier in §2.4** is the one circuit that _intentionally_ breaks unlinkability inside the (epoch, app) scope — that is its purpose.

---

## §6 Suggested rollout order

1. **§2.1 age range** + **§2.5 generic numeric** — share circuit shape (`assert value op threshold`); land both in one PR.
2. **§2.2 sanctions non-membership** (allow-list) — add new `approvedNotSanctioned` ledger tree + `seedNotSanctioned`.
3. **§2.3 PEP non-membership** — identical shape, different list root.
4. **§2.4 unique-personhood nullifier** — new ledger Set, different circuit shape; ship last.

After §6.4 lands, the §3 deferred set becomes pure template work.

---

## §7 Per-provider coverage

For each predicate, can the holder actually prove it privately given the
claims that provider attests? `✅` = yes; `⚠️` = only via dependent
attestation flow not yet wired; `❌` = source does not vouch for the
underlying attribute.

| Predicate                       |                             Mock-DigiD                             |                             Didit                              |              Google               |
| ------------------------------- | :----------------------------------------------------------------: | :------------------------------------------------------------: | :-------------------------------: |
| `age:>=18` / `>=21` / `>=65`    |                                 ✅                                 |                               ✅                               |                ❌                 |
| `age_range[min,max]`            |                                 ✅                                 |                               ✅                               |                ❌                 |
| `nationality:eu` (set)          |                                 ✅                                 |                               ✅                               |                ❌                 |
| `residency:verified`            |                             ✅ (form)                              |                    ❌ (`is_resident=false`)                    |                ❌                 |
| `kyc:>=basic` (Low)             |                                 ✅                                 |                               ✅                               |                ✅                 |
| `kyc:>=substantial` (Med)       |                                 ✅                                 |                               ✅                               |                ❌                 |
| `kyc:>=high` (High)             |                                 ❌                                 |                               ✅                               |                ❌                 |
| `income >= N`                   |                                 ❌                                 |                               ❌                               |                ❌                 |
| `credit_score >= N` (deferred)  |                                 ❌                                 |                               ❌                               |                ❌                 |
| `not_sanctioned`                |                                 ❌                                 | ⚠️ (Didit AML add-on, OwlID doesn't parse the `aml` block yet) |                ❌                 |
| `unique_personhood(epoch, app)` | ⚠️ (needs stable personhood_secret minted at issuance — not wired) |                           ⚠️ (same)                            | ⚠️ (derive from `sub`; not wired) |

### Why `kyc:>=basic` from Google?

Google's identity assurance is `Low` per eIDAS. That's enough to prove
"you have AN authenticated identity" but NOT "you are who the document
says you are" — there's no document, no liveness, no face-match. Use
Google credentials for sybil-resistance + email-verified flows, **not**
for AML/age-gated flows.

### What Didit's high-assurance buys

Document scan + liveness + face-match = full eIDAS High. Pairs with:

- Every age predicate (DOB on document)
- Nationality set-membership (issuing country on document)
- Sanctions non-membership (when AML block is wired — `DiditVerificationData`
  needs `aml_screening: Option<DiditAmlScreening>` + the issuer calls
  `seedNotSanctioned(persistentHash(nationalId))` to insert the holder)
- Unique-personhood (derive `personhood_secret = HKDF(issuer_salt,
national_id)` — survives credential rotation, lets the holder collide
  themselves intentionally across a (epoch, app) scope)

### What Google buys that Didit cannot

- **Email-verified.** Standard claim; Didit doesn't touch email.
- **Workspace org membership.** Google's `hd` claim names the Workspace
  domain — proves "I belong to corp.example".
- **Locale.** BCP-47 locale string; weak signal.
- **Stable account.** `sub` is durable; useful as personhood_secret seed.

---

## §8 Google-only feasible new predicates

These four are wholly enabled by what Google attests today and need only
a circuit + a normalizer extension.

### 8.1 `attestEmailVerified(rootHash)`

**Witness:** `emailVerifiedFlag(): Uint<8>` (`>=1` means verified).
**Public:** none.
**Circuit:** mirror of `attestResidency`. Param = zero.
**Surfaced claim:** `email_verified: true`.
**Source mapping:** Google `email_verified` boolean → witness value.

### 8.2 `attestEmailDomainIn(rootHash)` (allow-list inversion)

**Witness:** `emailDomainPath(): MerkleTreePath<5, Bytes<32>>`.
**Public:** none (set anchored in ledger).
**Circuit:** mirror of `attestNationalityIn`. Owner pre-populates
`approvedEmailDomain` tree with `persistentHash(domain)` leaves.
**Use case:** "I belong to an EDU domain", "I work at a Fortune 500
domain", "I am a corporate email holder".
**Privacy:** the actual domain never leaves the holder; verifier only
learns the boolean membership fact.

### 8.3 `attestWorkspaceOrgIn(rootHash)`

**Witness:** `workspaceOrgPath(): MerkleTreePath<5, Bytes<32>>`.
**Source:** Google `hd` claim (present only for Workspace logins; absent
for consumer Gmail).
**Circuit:** identical to 8.2; different ledger tree
(`approvedWorkspaceOrg`).
**Use case:** B2B SSO replacement — "I am at this org" without giving
the verifier any other Google identity.

### 8.4 Personhood-secret derivation for `attestUniquePersonhood`

**Source:** Google `sub` is durable per (user, OAuth client). Derive
`personhood_secret = HKDF-SHA-256(issuer_salt, "owlid:personhood" || sub)`
at credential issuance and store it client-side (PRF-wrapped by the
passkey).
**Caveat:** A holder with two Google accounts gets two distinct
personhood secrets. The same problem exists for Didit (one secret per
issued document); both providers are coarse-grained personhood, not
universal.

---

## §9 Combined Didit + Google flow

The strongest privacy-preserving bundle uses **both** providers via the
existing batch issuance path:

1. **Didit credential** → identity + age + nationality + KYC predicates
2. **Google credential** → email-verified + workspace + personhood
3. Both issued as **OpenID4VCI batch** (`OwlIssuer.issueBatch(8)`) →
   each presentation is a different one-time-use credential with a
   distinct `credential_id` and independent revocation slot.

A verifier asking `age >= 18 AND email_verified AND from EU` gets:

- one presentation from a Didit one-time-use credential disclosing
  `age_over_18: true` + `nationality_in_eu: true`,
- one presentation from a Google one-time-use credential disclosing
  `email_verified: true`,
- with NO correlation across the two presentations beyond what the
  verifier could already derive from the combined disclosures.
