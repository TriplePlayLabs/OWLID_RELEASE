//! Zero-knowledge circuit integration for OwlID.
//!
//! Three Groth16 circuits over BLS12-381:
//! - `age_range`   — prove `age >= threshold`
//! - `kyc_status`  — prove `kyc_level >= required`
//! - `nationality` — prove membership in a registered set (Pedersen Merkle tree)
//!
//! ## Key lifecycle
//!
//! Proving and verifying keys are produced once by `src/bin/keygen.rs` and
//! committed under `artifacts/`. **Setup never runs at process start.** The
//! lib loads the pre-computed keys via `include_bytes!` (when embedded) or
//! via a runtime hand-in (`set_proving_key_bytes`, used by the WASM build
//! that fetches keys over the network).
//!
//! Three feature flags govern which keys are linked:
//!
//! | Feature                  | What it does                                           |
//! |--------------------------|--------------------------------------------------------|
//! | `verifier` (default)     | Embeds VK bytes. `get_pvk()` works.                    |
//! | `prover-keys-embedded`   | Embeds PK bytes. `get_pk()` works without runtime setup.|
//! | `prover-keys-external`   | No PK bytes. Caller must `set_proving_key_bytes()`.    |
//!
//! Verifier-only deployments (verification-service) take just `verifier` so
//! the binary doesn't link the multi-MB proving keys.
//!
//! ## SECURITY
//!
//! Keys committed in `artifacts/` come from `keygen` with **fixed seeds**.
//! Anyone with this source has the toxic waste and can forge proofs.
//! Acceptable for development. **Replace with MPC ceremony output before
//! production** — see `crates/zk-circuits/CEREMONY.md`. Artifact paths
//! and consumer code do not change; only the bytes do.

pub mod age_range;
pub mod data;
pub mod error;
pub mod kyc_status;
pub mod nationality;
pub mod pedersen;
pub mod proof;

pub use error::ZkError;
pub use proof::{ZkProof, ZkProofType};

#[cfg(any(feature = "verifier", feature = "prover-keys-embedded", feature = "prover-keys-external"))]
use ark_bls12_381::Bls12_381;
#[cfg(any(feature = "verifier", feature = "prover-keys-embedded", feature = "prover-keys-external"))]
use ark_groth16::{PreparedVerifyingKey, ProvingKey};
#[cfg(any(feature = "verifier", feature = "prover-keys-embedded", feature = "prover-keys-external"))]
use ark_serialize::CanonicalDeserialize;

// ---------------------------------------------------------------------------
// Verifying keys (small, always embedded when the `verifier` feature is on)
// ---------------------------------------------------------------------------

#[cfg(feature = "verifier")]
mod vk {
    use super::*;
    use std::sync::LazyLock;

    pub(super) const AGE_RANGE_VK_BYTES: &[u8] =
        include_bytes!("../artifacts/age_range.vk.bin");
    pub(super) const KYC_STATUS_VK_BYTES: &[u8] =
        include_bytes!("../artifacts/kyc_status.vk.bin");
    pub(super) const NATIONALITY_VK_BYTES: &[u8] =
        include_bytes!("../artifacts/nationality.vk.bin");

    pub(super) static AGE_RANGE_VK: LazyLock<PreparedVerifyingKey<Bls12_381>> =
        LazyLock::new(|| deserialize_pvk(AGE_RANGE_VK_BYTES, "age_range"));
    pub(super) static KYC_STATUS_VK: LazyLock<PreparedVerifyingKey<Bls12_381>> =
        LazyLock::new(|| deserialize_pvk(KYC_STATUS_VK_BYTES, "kyc_status"));
    pub(super) static NATIONALITY_VK: LazyLock<PreparedVerifyingKey<Bls12_381>> =
        LazyLock::new(|| deserialize_pvk(NATIONALITY_VK_BYTES, "nationality"));

    fn deserialize_pvk(bytes: &[u8], name: &str) -> PreparedVerifyingKey<Bls12_381> {
        CanonicalDeserialize::deserialize_compressed(bytes)
            .unwrap_or_else(|e| panic!("Failed to deserialize {} verifying key: {}", name, e))
    }
}

/// Look up the prepared verification key for a given proof type. Loads from
/// embedded bytes on first access (single deserialization, ~ms).
#[cfg(feature = "verifier")]
pub fn get_pvk(proof_type: &ZkProofType) -> &'static PreparedVerifyingKey<Bls12_381> {
    match proof_type {
        ZkProofType::AgeRange => &vk::AGE_RANGE_VK,
        ZkProofType::KycStatus => &vk::KYC_STATUS_VK,
        ZkProofType::Nationality => &vk::NATIONALITY_VK,
    }
}

/// Pre-warm all VKs. Call from the verifier at boot so the first `/verify`
/// request doesn't pay the deserialization cost.
#[cfg(feature = "verifier")]
pub fn prewarm_verifying_keys() {
    let _ = &*vk::AGE_RANGE_VK;
    let _ = &*vk::KYC_STATUS_VK;
    let _ = &*vk::NATIONALITY_VK;
}

// ---------------------------------------------------------------------------
// Proving keys (large; embedded only when explicitly requested)
// ---------------------------------------------------------------------------

#[cfg(any(feature = "prover-keys-embedded", feature = "prover-keys-external"))]
mod pk {
    use super::*;
    use std::sync::OnceLock;

    pub(super) static AGE_RANGE_PK: OnceLock<&'static ProvingKey<Bls12_381>> = OnceLock::new();
    pub(super) static KYC_STATUS_PK: OnceLock<&'static ProvingKey<Bls12_381>> = OnceLock::new();
    pub(super) static NATIONALITY_PK: OnceLock<&'static ProvingKey<Bls12_381>> = OnceLock::new();

    pub(super) fn cell(t: &ZkProofType) -> &'static OnceLock<&'static ProvingKey<Bls12_381>> {
        match t {
            ZkProofType::AgeRange => &AGE_RANGE_PK,
            ZkProofType::KycStatus => &KYC_STATUS_PK,
            ZkProofType::Nationality => &NATIONALITY_PK,
        }
    }

    /// Deserialize bytes into a `ProvingKey`, leak it to obtain a `'static`
    /// reference (one PK per circuit per process — bounded leak).
    pub(super) fn install(t: &ZkProofType, bytes: &[u8]) -> Result<(), ZkError> {
        let pk: ProvingKey<Bls12_381> = CanonicalDeserialize::deserialize_compressed(bytes)
            .map_err(|e| ZkError::SetupFailed(format!("PK deserialize: {}", e)))?;
        let pk_ref: &'static ProvingKey<Bls12_381> = Box::leak(Box::new(pk));
        cell(t)
            .set(pk_ref)
            .map_err(|_| ZkError::SetupFailed(format!("Proving key for {:?} already loaded", t)))?;
        Ok(())
    }
}

#[cfg(feature = "prover-keys-embedded")]
mod pk_embedded {
    use super::*;

    const AGE_RANGE_PK_BYTES: &[u8] = include_bytes!("../artifacts/age_range.pk.bin");
    const KYC_STATUS_PK_BYTES: &[u8] = include_bytes!("../artifacts/kyc_status.pk.bin");
    const NATIONALITY_PK_BYTES: &[u8] = include_bytes!("../artifacts/nationality.pk.bin");

    /// First-touch loader: deserialize the embedded PK bytes for `t` into the
    /// shared cell. Idempotent — safe to call repeatedly.
    pub(super) fn ensure(t: &ZkProofType) {
        if pk::cell(t).get().is_some() {
            return;
        }
        let bytes = match t {
            ZkProofType::AgeRange => AGE_RANGE_PK_BYTES,
            ZkProofType::KycStatus => KYC_STATUS_PK_BYTES,
            ZkProofType::Nationality => NATIONALITY_PK_BYTES,
        };
        // Ignore "already loaded" race — another thread won.
        let _ = pk::install(t, bytes);
    }
}

/// Hand a proving key to the lib at runtime. Used by the WASM build, which
/// fetches PKs from the wallet PWA's origin instead of bundling them.
///
/// Returns an error if the key is already loaded (PKs are immutable per
/// process). Bytes must be the `ark-serialize` compressed form produced by
/// `keygen`.
#[cfg(feature = "prover-keys-external")]
pub fn set_proving_key_bytes(proof_type: &ZkProofType, bytes: &[u8]) -> Result<(), ZkError> {
    pk::install(proof_type, bytes)
}

/// Look up the proving key for a given proof type. Available only when one
/// of the prover-keys-* features is enabled. Panics if the key has not been
/// loaded — ensure your build embeds it (`prover-keys-embedded`) or hand it
/// in via `set_proving_key_bytes` (`prover-keys-external`) before proving.
#[cfg(any(feature = "prover-keys-embedded", feature = "prover-keys-external"))]
pub fn get_pk(proof_type: &ZkProofType) -> &'static ProvingKey<Bls12_381> {
    #[cfg(feature = "prover-keys-embedded")]
    pk_embedded::ensure(proof_type);

    pk::cell(proof_type).get().copied().unwrap_or_else(|| {
        panic!(
            "Proving key for {:?} not loaded. Build with feature \
             `prover-keys-embedded`, or call `set_proving_key_bytes` before \
             generating a proof.",
            proof_type
        )
    })
}

// ---------------------------------------------------------------------------
// Raw PK byte serving (for verifier-side static delivery to wallets)
// ---------------------------------------------------------------------------

/// Raw `include_bytes!` slices of the proving keys for static serving.
///
/// Available only when `serve-prover-keys` is on. Does NOT load the keys
/// into a `ProvingKey<Bls12_381>` — verifier-only deployments still skip
/// the proving-key deserializer. Lets the verification service expose
/// `GET /zk-keys/<circuit>.pk.bin` so wallet clients (whose WASM build
/// leaves PKs out) can fetch + cache them lazily.
#[cfg(feature = "serve-prover-keys")]
pub mod prover_key_bytes {
    pub const AGE_RANGE: &[u8] = include_bytes!("../artifacts/age_range.pk.bin");
    pub const KYC_STATUS: &[u8] = include_bytes!("../artifacts/kyc_status.pk.bin");
    pub const NATIONALITY: &[u8] = include_bytes!("../artifacts/nationality.pk.bin");

    /// Resolve a circuit name to its proving-key bytes. Names match the
    /// artifact filenames (`age_range`, `kyc_status`, `nationality`).
    pub fn lookup(name: &str) -> Option<&'static [u8]> {
        match name {
            "age_range" => Some(AGE_RANGE),
            "kyc_status" => Some(KYC_STATUS),
            "nationality" => Some(NATIONALITY),
            _ => None,
        }
    }

    /// List the served circuit names. Used to drive the wallet's prefetch
    /// list so the SDK and verifier never disagree on which circuits exist.
    pub const ALL: &[&str] = &["age_range", "kyc_status", "nationality"];
}
