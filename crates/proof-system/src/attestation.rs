//! Recompute a per-kind Midnight predicate attestation key off-chain.
//!
//! One Compact contract per predicate kind (devnet block-weight cap),
//! all keyed into a single SSE-mirrored attestation set. Each contract
//! derives the key as
//! `persistentHash<Vector<3, Bytes<32>>>([tag, rootHash, param])`.
//! Compact's `persistentHash` over a `Vector<n, Bytes<32>>` is exactly
//! `SHA-256( e0 || e1 || ... )` where each element is its fixed 32-byte
//! chunk — no domain separator, no length prefix. Verified against a
//! live on-chain key (see test).
//!
//! The verifier recomputes this from the credential's issuer-signed
//! `rootHash` + the requested predicate/param and checks membership in
//! the SSE-mirrored attestation set, instead of verifying a ZK proof
//! inline. Recomputing (not trusting a holder-supplied key) is what
//! binds the attestation to *this* credential.

use midnight_transient_crypto::curve::Fr;
use midnight_transient_crypto::hash::{degrade_to_transient, transient_hash};
use sha2::{Digest, Sha256};

/// Domain tag for the age-threshold predicate (`owlid:attest:age:`).
pub const TAG_AGE: &str = "owlid:attest:age:";
/// Domain tag for the kyc-level predicate (`owlid:attest:kyc:`).
pub const TAG_KYC: &str = "owlid:attest:kyc:";
/// Domain tag for the nationality set-membership predicate.
pub const TAG_NATIONALITY: &str = "owlid:attest:nat:";
/// Domain tag for the residency set-membership predicate
/// (`attestResidencyIn` — verifier-supplied allowed country set).
pub const TAG_RESIDENCY: &str = "owlid:attest:resin:";
/// Domain tag for the age-range predicate (`owlid:attest:agerng:`).
pub const TAG_AGE_RANGE: &str = "owlid:attest:agerng:";
/// Domain tag for the email-verified predicate.
pub const TAG_EMAIL_VERIFIED: &str = "owlid:attest:email:";
/// Domain tag for the unique-personhood predicate.
pub const TAG_UNIQUE_PERSONHOOD: &str = "owlid:attest:uniq:";
/// Domain tag for the DID owner-hash derivation in `identity_registry.compact`
/// (`persistentHash([pad(32, "owlid:did:owner:"), secretKey])`). Defined here so
/// the registry has a single source of truth and the uniqueness guard covers it.
pub const TAG_DID_OWNER: &str = "owlid:did:owner:";

/// Every security-bearing hash domain tag, mirrored in `docs/DOMAIN_SEPARATION.md`.
/// New hash use-sites MUST add their tag here so the uniqueness/min-length guard
/// fails CI on a duplicate or a too-short prefix.
pub const ALL_DOMAIN_TAGS: &[&str] = &[
    TAG_AGE,
    TAG_AGE_RANGE,
    TAG_KYC,
    TAG_NATIONALITY,
    TAG_RESIDENCY,
    TAG_EMAIL_VERIFIED,
    TAG_UNIQUE_PERSONHOOD,
    TAG_DID_OWNER,
];

fn pad32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    let b = s.as_bytes();
    // tags are short ASCII; right-pad with zeros (Compact `pad`).
    out[..b.len()].copy_from_slice(b);
    out
}

/// `value as Field as Bytes<32>` — little-endian, low byte first.
fn u128_le32(v: u128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..16].copy_from_slice(&v.to_le_bytes());
    out
}

fn key(tag: &str, root_hash: &[u8; 32], param: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(pad32(tag));
    h.update(root_hash);
    h.update(param);
    h.finalize().into()
}

/// Key for `attestAgeGte(owlRoot, threshold, asOfYmd)`. The freshness epoch is
/// bound into the param so a stale/forged date cannot pass; recompute it with
/// [`current_age_epoch`].
pub fn age_key(owl_root: &[u8; 32], threshold: u128, epoch_ymd: u32) -> [u8; 32] {
    let param = hash_pair(&u128_le32(threshold), &u128_le32(epoch_ymd as u128));
    key(TAG_AGE, owl_root, &param)
}

/// First day of the current UTC month as `YYYYMM01` — the age freshness epoch.
/// The verifier and the wallet derive this identically so the bound key matches.
pub fn current_age_epoch() -> u32 {
    use chrono::Datelike;
    let now = chrono::Utc::now();
    now.year() as u32 * 10_000 + now.month() * 100 + 1
}

/// Key for `attestKycGte(rootHash, threshold)`.
pub fn kyc_key(root_hash: &[u8; 32], threshold: u128) -> [u8; 32] {
    key(TAG_KYC, root_hash, &u128_le32(threshold))
}

/// Depth of the Compact `allowedCountryPath` Merkle witness
/// (`MerkleTreePath<MERKLE_DEPTH, Bytes<32>>`). Capacity = 2^DEPTH.
/// 8 → 256 leaves, enough for the entire ISO 3166-1 alpha-2 codepoint
/// set with headroom. Bumping requires recompiling the Compact
/// contracts and re-deploying.
pub const MERKLE_DEPTH: usize = 8;
/// Maximum verifier-supplied allowed-set size (= 2^MERKLE_DEPTH).
pub const COUNTRY_SET_SLOTS: usize = 1 << MERKLE_DEPTH;

/// 32-byte right-padded ISO 3166-1 alpha-2 country code — matches the
/// Compact-side `pad(32, "NL")` shape used in `attestResidencyIn` /
/// `attestNationalityIn` witnesses and the allowed-set slots.
pub fn pad_country(code: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    let b = code.as_bytes();
    let n = b.len().min(32);
    out[..n].copy_from_slice(&b[..n]);
    out
}

/// Canonicalise a verifier-supplied country list: uppercase, drop
/// non-alpha-2, dedupe, sort. The same canonical ordering is what the
/// holder's wallet feeds to the Compact `allowedCountrySet()` witness,
/// so both sides hash the exact same bytes.
fn canonicalise_countries(codes: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = codes
        .iter()
        .map(|c| c.trim().to_ascii_uppercase())
        .filter(|c| c.len() == 2 && c.chars().all(|ch| ch.is_ascii_alphabetic()))
        .collect();
    out.sort();
    out.dedup();
    out
}

/// SHA-256 of the OID4VP verifier `client_id` UTF-8 bytes. The Compact
/// `verifierIdHash()` witness returns the same 32 bytes; mixing it into
/// `setHash` ensures two verifiers asking for the same allowed-set
/// produce distinct on-chain keys (anti-rainbow-table + anti-cross-
/// verifier-correlation).
pub fn verifier_id_hash(client_id: &str) -> [u8; 32] {
    Sha256::digest(client_id.as_bytes()).into()
}

/// Compact runtime's internal Merkle-leaf-hash domain separator. The
/// `merkleTreePathRoot<DEPTH, Bytes<32>>` builtin first hashes each
/// leaf as `SHA-256("mdn:lh" || leaf)` and then degrades to Fr before
/// folding with `transientHash` up to the root. Verified empirically
/// against `@midnight-ntwrk/onchain-runtime-v3`'s `leafHash`.
const LEAF_DOMAIN_SEP: &[u8; 6] = b"mdn:lh";

/// Compact's per-leaf hash for `MerkleTree<DEPTH, Bytes<32>>` →
/// `Fr`. Mirrors the `merkleTreePathRoot` leaf step:
///   `Fr = degradeToTransient( SHA-256(LEAF_DOMAIN_SEP || leaf) )`.
/// The earlier (and incorrect) implementation skipped the
/// `persistentHash` step and degraded the raw leaf, producing a
/// different root and a silent on-chain attestation set-membership
/// miss for every nationality / residency presentation.
fn country_leaf_fr(country: &[u8; 32]) -> Fr {
    use midnight_transient_crypto::hash::HashOutput;
    let mut h = Sha256::new();
    h.update(LEAF_DOMAIN_SEP);
    h.update(country);
    let digest: [u8; 32] = h.finalize().into();
    degrade_to_transient(HashOutput(digest))
}

/// Hash one Merkle path step: `transient_hash([left, right])`. Mirrors
/// the stdlib `merkleTreePathEntryRoot` (Poseidon over BLS12-381
/// outer-scalar pair). Used to fold a path up to the root and also to
/// fill a full binary tree bottom-up off-chain.
fn merkle_node(left: Fr, right: Fr) -> Fr {
    transient_hash(&[left, right])
}

/// Compute the depth-`MERKLE_DEPTH` Merkle root of the verifier's
/// canonical allowed-set. The set is sorted + deduped + uppercased
/// + padded with zero-byte leaves to 2^MERKLE_DEPTH slots. Each leaf
/// is hashed via [`country_leaf_fr`] (the in-circuit leaf-hash for
/// `Bytes<32>` — `degradeToTransient(SHA-256("mdn:lh" || leaf))`),
/// then folded with `transient_hash` (Poseidon over BLS12-381 outer
/// scalar) up to the root, so the off-chain root identically equals
/// the in-circuit root the holder reconstructs via
/// `merkleTreePathRoot<DEPTH, Bytes<32>>`.
pub fn allowed_country_merkle_root(codes: &[&str]) -> Fr {
    let canon = canonicalise_countries(codes);
    let mut layer: Vec<Fr> = (0..COUNTRY_SET_SLOTS)
        .map(|i| {
            if let Some(code) = canon.get(i) {
                country_leaf_fr(&pad_country(code))
            } else {
                country_leaf_fr(&[0u8; 32])
            }
        })
        .collect();
    while layer.len() > 1 {
        layer = layer
            .chunks_exact(2)
            .map(|pair| merkle_node(pair[0], pair[1]))
            .collect();
    }
    layer[0]
}

/// Serialize an Fr to 32 little-endian bytes the same way the Compact
/// `disclose(root.field) as Bytes<32>` cast does. The high byte may be
/// zero for in-range field elements; the encoding is deterministic.
fn fr_to_le_bytes32(f: Fr) -> [u8; 32] {
    let bytes = f.as_le_bytes();
    let mut out = [0u8; 32];
    let n = bytes.len().min(32);
    out[..n].copy_from_slice(&bytes[..n]);
    out
}

/// `setHash` recipe — mirrors the Compact circuit:
///   root      = merkleTreePathRootNoLeafHash(sorted_padded_allowed_set)
///   set_hash  = SHA-256( verifierIdHash || fr_to_le_bytes32(root) )
///
/// `codes` is the verifier's raw input; canonicalisation (sort, dedupe,
/// uppercase) happens here so callers can pass user-typed lists. The
/// root is computed with `transient_hash` (Poseidon over BLS12-381
/// outer-scalar) so the in-circuit fold over the merkle path produces
/// the exact same Fr value.
pub fn allowed_country_set_hash(client_id: &str, codes: &[&str]) -> [u8; 32] {
    let root = allowed_country_merkle_root(codes);
    let root_bytes = fr_to_le_bytes32(root);
    let v_id = verifier_id_hash(client_id);
    let mut h = Sha256::new();
    h.update(v_id);
    h.update(root_bytes);
    h.finalize().into()
}

/// Key for `attestNationalityIn(rootHash, setHash)`. The `countries`
/// slice is the verifier-supplied allowed set; `client_id` is the
/// OID4VP verifier identity (typically the response_uri). Both bind
/// the on-chain key so neither cross-policy replay nor cross-verifier
/// replay is possible.
pub fn nationality_key(root_hash: &[u8; 32], client_id: &str, countries: &[&str]) -> [u8; 32] {
    key(
        TAG_NATIONALITY,
        root_hash,
        &allowed_country_set_hash(client_id, countries),
    )
}

/// Key for `attestResidencyIn(rootHash, setHash)`. Same shape as
/// nationality — different tag so the two predicates never collide.
pub fn residency_key(root_hash: &[u8; 32], client_id: &str, countries: &[&str]) -> [u8; 32] {
    key(
        TAG_RESIDENCY,
        root_hash,
        &allowed_country_set_hash(client_id, countries),
    )
}

/// `value as Field as Bytes<32>` for a 16-bit unsigned. Compact pads
/// the field element to 32 bytes little-endian; the high bytes are
/// zero for in-range Uint<16> values.
fn u16_le32(v: u16) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..2].copy_from_slice(&v.to_le_bytes());
    out
}

/// SHA-256 of the concatenation of two 32-byte chunks — the off-chain
/// mirror of Compact's `persistentHash<Vector<2, Bytes<32>>>`.
fn hash_pair(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(a);
    h.update(b);
    h.finalize().into()
}

/// Key for `attestAgeRange(owlRoot, min, max, asOfYmd)`.
/// Param = `persistentHash([minLE16, maxLE16, epochLE])`.
pub fn age_range_key(owl_root: &[u8; 32], min_age: u16, max_age: u16, epoch_ymd: u32) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(u16_le32(min_age));
    h.update(u16_le32(max_age));
    h.update(u128_le32(epoch_ymd as u128));
    let param: [u8; 32] = h.finalize().into();
    key(TAG_AGE_RANGE, owl_root, &param)
}

/// Key for `attestEmailVerified(rootHash)` — boolean fact, constant param.
pub fn email_verified_key(root_hash: &[u8; 32]) -> [u8; 32] {
    key(TAG_EMAIL_VERIFIED, root_hash, &[0u8; 32])
}

/// Effective personhood `app_id` — the verifier's campaign scope BOUND under
/// its authenticated identity. The verifier keeps a meaningful per-campaign
/// `app_id` (e.g. "conference-x"), but it is folded under
/// `verifier_id_hash(client_id)` so a *different* verifier choosing the same
/// campaign string lands in a *different* nullifier namespace (no cross-app
/// linkability) and no verifier can forge a foreign scope (F-2 /
/// DOMAIN_SEPARATION.md §2). Same verifier-salt recipe as
/// [`allowed_country_set_hash`]: `SHA-256(verifier_id_hash(client_id) || app_id)`.
pub fn personhood_app_id(client_id: &str, app_id: &[u8; 32]) -> [u8; 32] {
    hash_pair(&verifier_id_hash(client_id), app_id)
}

/// Key for `attestUniquePersonhood(rootHash, epoch, app_id)`.
/// Param = `persistentHash([epoch, app_id])`. `epoch` is the verifier's
/// campaign-period scope (opaque 32 bytes); `app_id` MUST be the effective
/// value from [`personhood_app_id`], so the campaign scope is bound to the
/// verifier identity. The on-chain key derivation here is unchanged by the
/// in-circuit nullifier domain tag — only the nullifier set membership
/// carries that tag.
pub fn unique_personhood_key(
    root_hash: &[u8; 32],
    epoch: &[u8; 32],
    app_id: &[u8; 32],
) -> [u8; 32] {
    let param = hash_pair(epoch, app_id);
    key(TAG_UNIQUE_PERSONHOOD, root_hash, &param)
}

// ============================================================================
// F-1 binding: issuer-signed claim commitments (`owl_root`).
//
// Binds a predicate witness to the issuer-signed credential so an attestation
// cannot be forged from a fabricated value.
// These mirror the Compact `claimCommit` / `merkleTreePathRoot` recipe; the
// cross-runtime parity vector is pinned once the circuits run on devnet.
// ============================================================================

/// `value as Bytes<32>` for an integer claim (kycLevel, dobInt, age, …).
pub fn claim_value_int(v: u128) -> [u8; 32] {
    u128_le32(v)
}

/// Issuer-signed commitment leaf for one disclosable claim:
/// `persistentHash<Vector<3,Bytes<32>>>([pad32(name), value32, salt32])`.
/// The per-claim `salt32` hides the value in the commitment.
pub fn claim_commit(name: &str, value32: &[u8; 32], salt32: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(pad32(name));
    h.update(value32);
    h.update(salt32);
    h.finalize().into()
}

/// Depth-[`MERKLE_DEPTH`] Merkle root over a credential's claim commitments —
/// the `owl_root` bound into every attestation key. Same leaf-hash + transient
/// fold as [`allowed_country_merkle_root`], so the in-circuit
/// `merkleTreePathRoot<MERKLE_DEPTH, Bytes<32>>` reconstructs the identical Fr.
/// Commitments are placed in order and the tree is zero-padded to 2^DEPTH slots.
pub fn owl_claims_root(commits: &[[u8; 32]]) -> [u8; 32] {
    assert!(
        commits.len() <= COUNTRY_SET_SLOTS,
        "too many claims for a depth-{MERKLE_DEPTH} tree (max {COUNTRY_SET_SLOTS})"
    );
    let zero = [0u8; 32];
    let mut layer: Vec<Fr> = (0..COUNTRY_SET_SLOTS)
        .map(|i| country_leaf_fr(commits.get(i).unwrap_or(&zero)))
        .collect();
    while layer.len() > 1 {
        layer = layer
            .chunks_exact(2)
            .map(|pair| merkle_node(pair[0], pair[1]))
            .collect();
    }
    fr_to_le_bytes32(layer[0])
}

/// Canonical `value as Bytes<32>` for a predicate-bearing claim, keyed by the
/// **standard SD-JWT VC claim name** the issuer actually signs (camelCase OwlID
/// attributes are mapped to these before issuance). Returns `None` for claims no
/// predicate binds. Keep in sync with the Compact circuits' `pad32(name)` and
/// the SDK `claimValue32`.
pub fn claim_value32(name: &str, value: &serde_json::Value) -> Option<[u8; 32]> {
    match name {
        // kyc level — value is a label (eIDAS/provider) or a number.
        "verification_level" => verification_level_to_u128(value).map(claim_value_int),
        // age — date of birth as YYYYMMDD.
        "birthdate" => date_to_yyyymmdd(value).map(|d| claim_value_int(d as u128)),
        // boolean facts.
        "email_verified" | "resident" => json_to_bool(value).map(|b| claim_value_int(b as u128)),
        // set-membership claims — country code. `residentCountry` is unmapped by
        // the SD-JWT bridge so it keeps its camelCase name.
        "nationality" | "residentCountry" => value.as_str().map(pad_country),
        // unique-personhood secret — issuer-derived 32-byte hex.
        "personhoodSecret" => hex_to_32(value),
        _ => None,
    }
}

fn hex_to_32(value: &serde_json::Value) -> Option<[u8; 32]> {
    let v = hex::decode(value.as_str()?.trim_start_matches("0x")).ok()?;
    v.as_slice().try_into().ok()
}

/// Map a `verification_level` claim (label or number) to its integer level.
/// Mirrors `issuer-service`'s `verification_level_to_u64` and the SDK
/// `kycLevelToNumber`, so issuer / wallet / circuit agree on the bound value.
fn verification_level_to_u128(value: &serde_json::Value) -> Option<u128> {
    if let Some(n) = json_to_u128(value) {
        return Some(n);
    }
    match value.as_str()?.trim().to_ascii_lowercase().as_str() {
        "none" | "" => Some(0),
        "low" | "basic" => Some(1),
        "medium" | "substantial" => Some(2),
        "high" => Some(3),
        _ => None,
    }
}

fn json_to_u128(v: &serde_json::Value) -> Option<u128> {
    match v {
        serde_json::Value::Number(n) => n.as_u64().map(u128::from),
        serde_json::Value::String(s) => s.trim().parse::<u128>().ok(),
        _ => None,
    }
}

fn json_to_bool(v: &serde_json::Value) -> Option<bool> {
    match v {
        serde_json::Value::Bool(b) => Some(*b),
        serde_json::Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "1" => Some(true),
            "false" | "no" | "0" => Some(false),
            _ => None,
        },
        serde_json::Value::Number(n) => n.as_u64().map(|x| x != 0),
        _ => None,
    }
}

/// `"YYYY-MM-DD"` → `YYYYMMDD` integer (e.g. `2006-06-24` → `20060624`).
fn date_to_yyyymmdd(v: &serde_json::Value) -> Option<u32> {
    let s = v.as_str()?;
    let mut it = s.split('-');
    let y: u32 = it.next()?.parse().ok()?;
    let m: u32 = it.next()?.parse().ok()?;
    let d: u32 = it.next()?.parse().ok()?;
    if m == 0 || m > 12 || d == 0 || d > 31 {
        return None;
    }
    Some(y * 10_000 + m * 100 + d)
}

/// `owl_root` over a credential's disclosures: the depth-[`MERKLE_DEPTH`] root of
/// the claim commitments for every predicate-bearing claim, leaves placed in
/// claim-name order. `(name, disclosure_salt, value)` per entry; the per-claim
/// `salt32` is `sha256(disclosure_salt)`. Issuer-signed into the JWT and opened
/// in-circuit, this is what binds a predicate witness to the credential (F-1).
pub fn owl_root_for_claims(entries: &[(String, String, serde_json::Value)]) -> [u8; 32] {
    let mut commits: Vec<(String, [u8; 32])> = entries
        .iter()
        .filter_map(|(name, salt, value)| {
            claim_value32(name, value).map(|v32| {
                let salt32: [u8; 32] = Sha256::digest(salt.as_bytes()).into();
                (name.clone(), claim_commit(name, &v32, &salt32))
            })
        })
        .collect();
    commits.sort_by(|a, b| a.0.cmp(&b.0));
    let leaves: Vec<[u8; 32]> = commits.into_iter().map(|(_, c)| c).collect();
    owl_claims_root(&leaves)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Domain tags must be pairwise distinct — a duplicate would let one
    /// predicate's attestation key collide with another's (cross-predicate
    /// replay). Guards the registry in `docs/DOMAIN_SEPARATION.md`.
    #[test]
    fn domain_tags_unique() {
        let mut seen = std::collections::HashSet::new();
        for tag in ALL_DOMAIN_TAGS {
            assert!(seen.insert(*tag), "duplicate domain tag: {tag}");
        }
    }

    /// Every tag is `owlid:`-namespaced, ≥6 bytes (so it cannot be a prefix of a
    /// bare value), and fits the 32-byte `pad32` slot used on the Compact side.
    #[test]
    fn domain_tags_well_formed() {
        for tag in ALL_DOMAIN_TAGS {
            assert!(tag.starts_with("owlid:"), "tag lacks owlid: namespace: {tag}");
            assert!(tag.len() >= 6, "tag shorter than 6 bytes: {tag}");
            assert!(tag.len() <= 32, "tag exceeds 32-byte pad slot: {tag}");
        }
    }

    // ---- F-1 binding foundation (owl_root) -------------------------------

    #[test]
    fn claim_commit_is_deterministic_and_salt_sensitive() {
        let v = claim_value_int(3);
        let s1 = [0x11u8; 32];
        let s2 = [0x22u8; 32];
        assert_eq!(claim_commit("kycLevel", &v, &s1), claim_commit("kycLevel", &v, &s1));
        assert_ne!(
            claim_commit("kycLevel", &v, &s1),
            claim_commit("kycLevel", &v, &s2),
            "salt must change the commitment"
        );
    }

    #[test]
    fn claim_commit_is_value_and_name_sensitive() {
        let s = [0x33u8; 32];
        assert_ne!(
            claim_commit("kycLevel", &claim_value_int(2), &s),
            claim_commit("kycLevel", &claim_value_int(3), &s),
            "value must change the commitment"
        );
        assert_ne!(
            claim_commit("kycLevel", &claim_value_int(3), &s),
            claim_commit("ageValue", &claim_value_int(3), &s),
            "claim name must change the commitment"
        );
    }

    #[test]
    fn owl_root_is_deterministic_and_content_sensitive() {
        let salt = [0x44u8; 32];
        let a = claim_commit("dateOfBirth", &claim_value_int(20_060_624), &salt);
        let b = claim_commit("kycLevel", &claim_value_int(2), &salt);
        let root1 = owl_claims_root(&[a, b]);
        let root2 = owl_claims_root(&[a, b]);
        assert_eq!(root1, root2, "root must be deterministic");
        assert_ne!(root1, [0u8; 32], "root must be non-trivial");
        // order matters (positional commitment)
        assert_ne!(owl_claims_root(&[a, b]), owl_claims_root(&[b, a]));
        // a changed value flips the root
        let a2 = claim_commit("dateOfBirth", &claim_value_int(20_060_625), &salt);
        assert_ne!(owl_claims_root(&[a, b]), owl_claims_root(&[a2, b]));
    }

    #[test]
    fn owl_root_rejects_overfull_claim_set() {
        let too_many = vec![[0u8; 32]; COUNTRY_SET_SLOTS + 1];
        let r = std::panic::catch_unwind(|| owl_claims_root(&too_many));
        assert!(r.is_err(), "must reject more claims than tree slots");
    }

    /// The age key binds the freshness epoch: same (root, threshold) under a
    /// different month must produce a different key (so a stale/forged date
    /// cannot pass), and the recipe is deterministic within a month.
    #[test]
    fn age_key_binds_epoch() {
        let root = [0xc3u8; 32];
        let june = age_key(&root, 18, 20_240_601);
        let july = age_key(&root, 18, 20_240_701);
        assert_ne!(june, july, "epoch must change the key");
        assert_eq!(june, age_key(&root, 18, 20_240_601), "deterministic");
        assert_ne!(june, age_key(&root, 21, 20_240_601), "threshold must change the key");
    }

    /// F-2: the verifier keeps a meaningful per-campaign `app_id`, but it is
    /// bound under the verifier identity. Same campaign string under two
    /// distinct verifiers must land in distinct nullifier namespaces (no
    /// cross-app linkability), while distinct campaigns under one verifier
    /// stay distinct (per-campaign scoping preserved).
    #[test]
    fn personhood_app_id_binds_campaign_under_verifier() {
        let root = [0x7au8; 32];
        let epoch = [0x01u8; 32];
        let campaign = [0xcau8; 32]; // e.g. "conference-x"
        let other_campaign = [0xcbu8; 32];

        // Same campaign string, different verifiers → different effective scope.
        let a = personhood_app_id("https://a.example", &campaign);
        let b = personhood_app_id("https://b.example", &campaign);
        assert_ne!(a, b, "same campaign under distinct verifiers must not collide");

        // Different campaigns, same verifier → different scope (per-campaign).
        let a2 = personhood_app_id("https://a.example", &other_campaign);
        assert_ne!(a, a2, "distinct campaigns under one verifier must differ");

        // Deterministic, and folded through to the key.
        assert_eq!(a, personhood_app_id("https://a.example", &campaign), "deterministic");
        assert_ne!(
            unique_personhood_key(&root, &epoch, &a),
            unique_personhood_key(&root, &epoch, &b),
            "verifier binding must reach the on-chain key",
        );
    }

    /// Canonicalisation: input ordering / duplication / case must not
    /// change `setHash`. The verifier and holder both call this before
    /// hashing — if they ever disagree the on-chain key will not match.
    #[test]
    fn allowed_set_hash_is_canonical() {
        let verifier = "https://verifier.example.com";
        let h1 = allowed_country_set_hash(verifier, &["NL", "BE", "DE"]);
        let h2 = allowed_country_set_hash(verifier, &["de", "nl", "be"]);
        let h3 = allowed_country_set_hash(verifier, &["NL", "DE", "BE", "NL", "be"]);
        assert_eq!(h1, h2, "case folding broke canonicalisation");
        assert_eq!(h1, h3, "dedup / sort broke canonicalisation");
    }

    /// Per-verifier salt is load-bearing: two distinct verifier ids
    /// asking the same allowed-set must produce distinct keys. If this
    /// regresses, well-known policy hashes become globally identifiable.
    #[test]
    fn allowed_set_hash_changes_per_verifier() {
        let codes = ["NL", "BE", "DE"];
        let a = allowed_country_set_hash("https://verifier-a.example", &codes);
        let b = allowed_country_set_hash("https://verifier-b.example", &codes);
        assert_ne!(a, b, "verifier salt was not folded into setHash");
    }

    /// The on-chain key recipe is `SHA-256(tag || rootHash || setHash)`.
    /// Residency and nationality keys with the same rootHash + same set
    /// + same verifier must NEVER collide (different tag bytes).
    #[test]
    fn residency_and_nationality_keys_never_collide() {
        let root = [0x42u8; 32];
        let r = residency_key(&root, "https://v.example", &["NL"]);
        let n = nationality_key(&root, "https://v.example", &["NL"]);
        assert_ne!(r, n, "tag domain separation collapsed");
    }

    /// Cross-runtime parity vector for the allowed-set Merkle root.
    /// Generated by feeding the canonical EU-27 set to
    /// `StateBoundedMerkleTree(8).update(..).rehash().root()` in
    /// `@midnight-ntwrk/onchain-runtime-v3` (compact-runtime 0.16.0)
    /// and reading `root().value[0]` (LE Fr bytes). Any drift in the
    /// leaf-hash recipe (e.g. dropping the `"mdn:lh"` domain separator
    /// or skipping `persistentHash`) makes this test fail and produces
    /// a silent on-chain attestation set-membership miss in prod.
    #[test]
    fn allowed_country_merkle_root_matches_compact_runtime_eu27() {
        let eu27 = [
            "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
            "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
        ];
        let root_fr = allowed_country_merkle_root(&eu27);
        assert_eq!(
            hex::encode(fr_to_le_bytes32(root_fr)),
            "c2086000af9e7ba57d1921b52bded3644aa0ce9f58ec65ee2c4c0353d8a48f19",
            "merkle root drifted from compact-runtime leafHash recipe \
             (`degradeToTransient(SHA-256(\"mdn:lh\" || leaf))`)"
        );
    }

    /// Same EU-27 set + prod verifier id → setHash parity vector. Pins
    /// the `SHA-256( SHA-256(verifier_id) || rootBytesLE )` recipe and
    /// guards against any future drift in the `verifierIdHash` or
    /// root-bytes byte order.
    #[test]
    fn allowed_country_set_hash_eu27_prod_verifier() {
        let eu27 = [
            "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
            "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
        ];
        let set_hash = allowed_country_set_hash("https://verifier.owlid.app", &eu27);
        assert_eq!(
            hex::encode(set_hash),
            "18061bdffb4f5a5f66e543b5177489fe398390b3b6ef84c8116595fa5dbd9b22",
        );
    }

    /// Full `attestNationalityIn` key parity: EU-27 + prod verifier id
    /// + a fixed sentinel `rootHash = [0xab; 32]`. The expected key was
    /// generated off-chain via `@midnight-ntwrk/compact-runtime` against
    /// the same recipes the Compact circuit emits. Any byte-level drift
    /// in tag padding, root-hash placement, or setHash recipe breaks
    /// this test BEFORE production prod presentations regress.
    #[test]
    fn nationality_key_eu27_prod_verifier_parity() {
        let eu27 = [
            "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
            "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
        ];
        let root = [0xabu8; 32];
        let key = nationality_key(&root, "https://verifier.owlid.app", &eu27);
        assert_eq!(
            hex::encode(key),
            "7aacc9e98a6faf6d98d854288e5f8bf441cacde7fba35298478bb2c9c80b6f14",
        );
    }
}

#[cfg(test)]
mod owl_root_vector {
    use super::*;
    use serde_json::json;

    /// Cross-runtime parity anchor: this exact `owl_root` is asserted in the
    /// SDK test `owl-root.test.ts` so the Rust issuer and the TS wallet build
    /// the identical commitment (`given_name` is non-predicate → not bound).
    #[test]
    fn owl_root_fixed_vector() {
        // Standard SD-JWT claim names + a kyc label ("high" → level 3).
        let entries = vec![
            ("verification_level".to_string(), "saltAAA".to_string(), json!("high")),
            ("birthdate".to_string(), "saltBBB".to_string(), json!("2006-06-24")),
            ("given_name".to_string(), "saltCCC".to_string(), json!("Ada")),
        ];
        let root = hex::encode(owl_root_for_claims(&entries));
        // kyc claim commitment (leaf the circuit's claimPath proves)
        let salt32: [u8; 32] = Sha256::digest("saltAAA".as_bytes()).into();
        let commit = hex::encode(claim_commit(
            "verification_level",
            &claim_value_int(3),
            &salt32,
        ));
        assert_eq!(root, "cb4b32bc1c2a108183ec21e89000d1a1ce84cf94721ed151142a192ea2ea714a");
        assert_eq!(commit, "a4e9513ff4da36a51d92050629b452c2e0a2d8bcd7688476f87de0646659e16f");
    }
}
