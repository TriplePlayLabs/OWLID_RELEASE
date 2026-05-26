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

/// Key for `attestAgeGte(rootHash, threshold)`.
pub fn age_key(root_hash: &[u8; 32], threshold: u128) -> [u8; 32] {
    key(TAG_AGE, root_hash, &u128_le32(threshold))
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

/// Key for `attestAgeRange(rootHash, min, max)`. Param = `persistentHash([minLE16, maxLE16])`.
pub fn age_range_key(root_hash: &[u8; 32], min_age: u16, max_age: u16) -> [u8; 32] {
    let param = hash_pair(&u16_le32(min_age), &u16_le32(max_age));
    key(TAG_AGE_RANGE, root_hash, &param)
}

/// Key for `attestEmailVerified(rootHash)` — boolean fact, constant param.
pub fn email_verified_key(root_hash: &[u8; 32]) -> [u8; 32] {
    key(TAG_EMAIL_VERIFIED, root_hash, &[0u8; 32])
}

/// Key for `attestUniquePersonhood(rootHash, epoch, app_id)`.
/// Param = `persistentHash([epoch, app_id])` — both are 32-byte values
/// the verifier already holds (they form the scope of the nullifier).
pub fn unique_personhood_key(
    root_hash: &[u8; 32],
    epoch: &[u8; 32],
    app_id: &[u8; 32],
) -> [u8; 32] {
    let param = hash_pair(epoch, app_id);
    key(TAG_UNIQUE_PERSONHOOD, root_hash, &param)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parity vector captured from a live chain attestation:
    /// attestAgeGte(rootHash = 0xc3 * 32, threshold = 18) produced the
    /// on-chain / SSE-mirrored key below. Cross-checked against
    /// @midnight-ntwrk/compact-runtime `persistentHash`.
    #[test]
    fn age_key_matches_onchain() {
        let root = [0xc3u8; 32];
        let k = age_key(&root, 18);
        assert_eq!(
            hex::encode(k),
            "06d8de25a0b753174c1ff95d44c1085b4fa2c131cb106ac9b4eb4788933c8bd1"
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
