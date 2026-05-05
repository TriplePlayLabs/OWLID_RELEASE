//! T-016: Zero-Knowledge Circuit Integration
//!
//! Provides ZK circuits for privacy-preserving credential predicates:
//! - Age range proofs (prove age >= threshold without revealing exact age)
//! - Nationality predicates (prove EU citizenship without revealing country)
//! - KYC status proofs (prove KYC level without revealing details)
//!
//! Uses Groth16 proving system over BLS12-381.
//! Nationality circuit uses JubJub Pedersen Merkle tree (1 public input).
//!
//! All proving and verification use cached keys from a single setup per circuit.
//! This ensures proofs generated with `get_pk` verify against `get_pvk`.

pub mod age_range;
pub mod error;
pub mod kyc_status;
pub mod nationality;
pub mod pedersen;
pub mod proof;

pub use error::ZkError;
pub use proof::{ZkProof, ZkProofType};

use ark_bls12_381::Bls12_381;
use ark_groth16::{PreparedVerifyingKey, ProvingKey};
use std::sync::LazyLock;

/// Cached proving + verification keys for the age range circuit.
static AGE_RANGE_KEYS: LazyLock<(ProvingKey<Bls12_381>, PreparedVerifyingKey<Bls12_381>)> =
    LazyLock::new(|| age_range::setup().expect("age_range setup must succeed"));

/// Cached proving + verification keys for the KYC status circuit.
static KYC_STATUS_KEYS: LazyLock<(ProvingKey<Bls12_381>, PreparedVerifyingKey<Bls12_381>)> =
    LazyLock::new(|| kyc_status::setup().expect("kyc_status setup must succeed"));

/// Cached proving + verification keys for the nationality circuit (Pedersen Merkle tree).
static NATIONALITY_KEYS: LazyLock<(ProvingKey<Bls12_381>, PreparedVerifyingKey<Bls12_381>)> =
    LazyLock::new(|| {
        nationality::setup().expect("nationality setup must succeed")
    });

/// Look up the cached proving key for a given proof type.
pub fn get_pk(proof_type: &ZkProofType) -> &'static ProvingKey<Bls12_381> {
    match proof_type {
        ZkProofType::AgeRange => &AGE_RANGE_KEYS.0,
        ZkProofType::Nationality => &NATIONALITY_KEYS.0,
        ZkProofType::KycStatus => &KYC_STATUS_KEYS.0,
    }
}

/// Look up the cached prepared verification key for a given proof type.
pub fn get_pvk(proof_type: &ZkProofType) -> &'static PreparedVerifyingKey<Bls12_381> {
    match proof_type {
        ZkProofType::AgeRange => &AGE_RANGE_KEYS.1,
        ZkProofType::Nationality => &NATIONALITY_KEYS.1,
        ZkProofType::KycStatus => &KYC_STATUS_KEYS.1,
    }
}
