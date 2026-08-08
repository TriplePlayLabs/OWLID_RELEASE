# Domain-Separation Registry

Authoritative list of every hash domain-separator used across OwlID, on both
the Compact (on-chain) and Rust (off-chain) sides. A hash input space is only
safe if every distinct use-site is prefixed with a fixed, unique tag, so a value
hashed for one purpose can never be replayed as a value hashed for another
(Trail-of-Bits "Frozen Heart" / Fiat-Shamir-domain-collision class).

**Rule.** Every `persistentHash` / SHA-256 use-site that derives a security-
bearing value (attestation key, nullifier, owner hash, recovery key) MUST lead
its input with a `≥6`-byte tag from the table below. Tags are versioned in the
string itself (`:v1`) — changing a recipe means a new tag, never a silent
in-place edit (an in-place edit is a breaking on-chain migration).

The Rust↔Compact parity for these tags is guarded by tests in
`crates/proof-system/src/attestation.rs` (`domain_tags_*`). The on-chain key
recipes are pinned by live parity vectors in the same module.

---

## 1. Registry

| #   | Tag (exact bytes)                | Rust                     | Compact                               | Use-site                                     | Recipe                                                |
| --- | -------------------------------- | ------------------------ | ------------------------------------- | -------------------------------------------- | ----------------------------------------------------- |
| 1   | `owlid:attest:age:`              | `TAG_AGE`                | `predicate_age.compact`               | age-threshold attestation key                | `SHA256(pad32(tag) ‖ rootHash ‖ thresholdLE32)`       |
| 2   | `owlid:attest:agerng:`           | `TAG_AGE_RANGE`          | `predicate_age_range.compact`         | age-range attestation key                    | `SHA256(pad32(tag) ‖ rootHash ‖ H(minLE16‖maxLE16))`  |
| 3   | `owlid:attest:kyc:`              | `TAG_KYC`                | `predicate_kyc.compact`               | kyc-level attestation key                    | `SHA256(pad32(tag) ‖ rootHash ‖ thresholdLE32)`       |
| 4   | `owlid:attest:nat:`              | `TAG_NATIONALITY`        | `predicate_nationality.compact`       | nationality set-membership key               | `SHA256(pad32(tag) ‖ rootHash ‖ setHash)`             |
| 5   | `owlid:attest:resin:`            | `TAG_RESIDENCY`          | `predicate_residency.compact`         | residency set-membership key                 | `SHA256(pad32(tag) ‖ rootHash ‖ setHash)`             |
| 6   | `owlid:attest:email:`            | `TAG_EMAIL_VERIFIED`     | `predicate_email.compact`             | email-verified boolean key                   | `SHA256(pad32(tag) ‖ rootHash ‖ 0³²)`                 |
| 7   | `owlid:attest:uniq:`             | `TAG_UNIQUE_PERSONHOOD`  | `predicate_personhood.compact`        | unique-personhood key                        | `SHA256(pad32(tag) ‖ rootHash ‖ H(epoch‖appId))`      |
| 8   | `owlid:did:owner:`               | `TAG_DID_OWNER`          | `identity_registry.compact`           | DID owner-hash derivation                    | `persistentHash([pad32(tag), secretKey])`             |
| 9   | `mdn:lh`                         | `LEAF_DOMAIN_SEP`        | Compact stdlib (`merkleTreePathRoot`) | Merkle leaf hash for `Bytes<32>` trees       | `degradeToTransient(SHA256(tag ‖ leaf))`              |
| 10  | `owlid:personhood:identity\0`    | `credential_bridge.rs`   | — (off-chain only)                    | issuer-side personhood identity hash         | `SHA256(tag ‖ ns ‖ \0 ‖ id)`                          |
| 11  | `owlid:personhood:secret`        | `credential_bridge.rs`   | — (off-chain only)                    | HKDF-expand info for personhood secret       | HKDF info string                                      |
| 12  | `owlid:credential-recovery:v1\0` | `issuer-service/main.rs` | — (off-chain only)                    | recovery-index HMAC                          | `HMAC-SHA256(secret, tag ‖ material)`                 |
| 13  | `owlid:recovery-file:v1`         | `sdk/recovery-file.ts`   | — (client only)                       | offline recovery-file KEK (PBKDF2 salt/info) | see [recovery-file](#3-non-hash-and-client-only-tags) |
| 14  | `owlid:revocation:self`          | `SELF_REVOKE_AUDIENCE`   | — (JWT `aud`, not a hash)             | self-revocation KB-JWT audience bind         | n/a                                                   |
| 15  | `owlid:nullifier:uniq:`          | — (in-circuit only)      | `predicate_personhood.compact`        | personhood anti-replay nullifier             | `SHA256(pad32(tag) ‖ secret ‖ epoch ‖ appId)`         |
| 16  | `owlid:issuer:key:`              | sidecar `issuerKeyHash`  | `issuer_registry.compact`             | issuer-key → registry map key                | `SHA256(pad32(tag) ‖ publicKey)`                      |

`pad32(tag)` = right-zero-padded to 32 bytes (Compact `pad(32, ...)`).
`H(..)` = `persistentHash<Vector<2,Bytes<32>>>` = `SHA256` of the two 32-byte
chunks. Tags 1–9, 15, 16 are security-bearing on-chain; 10–13 off-chain; 14 is a
JWT audience, listed so the namespace stays collision-free. Tag 15 is computed
only in-circuit (no off-chain consumer), so it has no Rust mirror; tag 16's
off-chain mirror is the sidecar's `issuerKeyHash` (the verification-service
receives the hash from sidecar events, never recomputes it).

---

## 2. Intermediate hashes wrapped by a tagged outer key

These two sites compute an **intermediate** value that is never used directly as
a key or nullifier — it is always fed into a `keyOf(<unique tag>, root, param)`
whose output (the security-bearing value) is domain-separated by tag 4/5/2. So
the §1 rule ("the value that keys/nullifies must lead with a tag") is satisfied
at the level that matters; tagging the intermediate would be a breaking on-chain
migration for no additional separation. Recorded here so the property is
auditable, not accidental.

| Site                                                | Intermediate hash                        | Why it needs no own tag                                                    | Severity |
| --------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------- | -------- |
| `predicate_{nationality,residency}.compact` setHash | `persistentHash([verifierIdHash, root])` | only ever the `param` of `keyOf(owlid:attest:{nat,resin}:, root, setHash)` | LOW      |
| `predicate_age_range.compact`                       | `persistentHash([minLE16, maxLE16])`     | only ever the `param` of `keyOf(owlid:attest:agerng:, root, param)`        | LOW      |

The single genuinely-bare site — `issuer_registry`'s lone-`Bytes<32>` issuer-key
hash, the only one whose output was used **directly** as a map key — was
domain-tagged (tag 16, F-3). These recipes mirrored in Rust (`attestation.rs`
`hash_pair`, `allowed_country_set_hash`) are pinned to the Compact bytes by
parity tests, so a drift on either side fails CI before it reaches a presentation.

---

## 3. Non-hash and client-only tags

- **`owlid:recovery-file:v1`** (tag 13) — salt/info for the offline
  recovery-file KEK derivation (PBKDF2-SHA256 → AES-256-GCM), separate from the
  passkey-PRF wrap (`owlid:sd-jwt-vc:holder-key:v1`) and the server-backup wrap
  (`owlid:credential-recovery:v1`). See `packages/sdk/src/recovery-file.ts`.
- **`owlid:revocation:self`** (tag 14) — KB-JWT `aud` for holder self-revocation;
  binds the JWT to the revoke endpoint so it cannot be replayed elsewhere.

### Client-side wrap salts (WebAuthn PRF)

| Salt                            | Purpose                                         |
| ------------------------------- | ----------------------------------------------- |
| `owlid:sd-jwt-vc:holder-key:v1` | at-rest wrap of the holder seed in localStorage |
| `owlid:credential-recovery:v1`  | wrap of the server-side recovery backup         |

These are PRF-eval salts, not hash domain-separators, but share the `owlid:`
namespace and are listed to keep it collision-free.

---

## 4. Maintenance

- Adding a hash use-site → add a row here AND a `TAG_*` const in
  `attestation.rs`, then reference it in the `domain_tags_unique` test so CI
  fails if it duplicates an existing tag.
- Changing a recipe → bump the tag version (`:v2`), never edit in place; ship the
  migration.
- The uniqueness + min-length invariant is enforced by
  `crates/proof-system/src/attestation.rs::tests::domain_tags_unique` and
  `::domain_tags_well_formed`.
