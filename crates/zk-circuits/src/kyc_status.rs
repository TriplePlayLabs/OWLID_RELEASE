//! KYC status predicate circuit
//!
//! Proves that a KYC verification level meets a minimum threshold
//! without revealing the exact level or verification details.
//!
//! KYC Levels:
//! - 0: Unverified
//! - 1: Basic (email/phone verified)
//! - 2: Standard (document verified)
//! - 3: Enhanced (document + liveness + AML)

use ark_bls12_381::{Bls12_381, Fr};
use ark_groth16::{Groth16, PreparedVerifyingKey, ProvingKey};
use ark_r1cs_std::{fields::fp::FpVar, prelude::*};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use ark_snark::SNARK;
use ark_std::rand::{rngs::OsRng, rngs::StdRng, SeedableRng};

use crate::error::ZkError;
use crate::proof::{ZkProof, ZkProofType};

/// KYC level threshold circuit: proves level >= required_level
#[derive(Clone)]
pub struct KycStatusCircuit {
    /// Private: the actual KYC level (0-3)
    pub level: Option<u64>,
    /// Public: the minimum required level
    pub required_level: Option<u64>,
}

impl ConstraintSynthesizer<Fr> for KycStatusCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        // Allocate private KYC level witness
        let level_var = FpVar::new_witness(cs.clone(), || {
            self.level
                .map(Fr::from)
                .ok_or(SynthesisError::AssignmentMissing)
        })?;

        // Allocate public required level input
        let required_var = FpVar::new_input(cs.clone(), || {
            self.required_level
                .map(Fr::from)
                .ok_or(SynthesisError::AssignmentMissing)
        })?;

        // Compute difference = level - required_level
        let diff = &level_var - &required_var;

        // Enforce non-negative: decompose into bits, ensure fits in 2 bits (max diff = 3)
        let bits = diff.to_bits_le()?;
        for bit in bits.iter().skip(2) {
            bit.enforce_equal(&Boolean::FALSE)?;
        }

        Ok(())
    }
}

/// Setup: generate proving and verification keys
pub fn setup() -> Result<(ProvingKey<Bls12_381>, PreparedVerifyingKey<Bls12_381>), ZkError> {
    let circuit = KycStatusCircuit {
        level: None,
        required_level: None,
    };

    let (pk, vk) = Groth16::<Bls12_381>::circuit_specific_setup(circuit, &mut StdRng::seed_from_u64(0x0B1C_0002))
        .map_err(|e| ZkError::SetupFailed(e.to_string()))?;

    let pvk = Groth16::<Bls12_381>::process_vk(&vk)
        .map_err(|e| ZkError::SetupFailed(e.to_string()))?;

    Ok((pk, pvk))
}

/// Generate a proof that KYC level >= required level
pub fn prove(
    pk: &ProvingKey<Bls12_381>,
    level: u64,
    required_level: u64,
) -> Result<ZkProof, ZkError> {
    if required_level > 3 {
        return Err(ZkError::InvalidInput(
            "Required KYC level must be 0-3".to_string(),
        ));
    }
    if level > 3 || level < required_level {
        return Err(ZkError::PreconditionFailed);
    }

    let circuit = KycStatusCircuit {
        level: Some(level),
        required_level: Some(required_level),
    };

    let proof = Groth16::<Bls12_381>::prove(pk, circuit, &mut OsRng)
        .map_err(|e| ZkError::ProofGenerationFailed(e.to_string()))?;

    let mut proof_bytes = Vec::new();
    CanonicalSerialize::serialize_compressed(&proof, &mut proof_bytes)
        .map_err(|e| ZkError::SerializationError(e.to_string()))?;

    let required_fr = Fr::from(required_level);
    let mut required_bytes = Vec::new();
    CanonicalSerialize::serialize_compressed(&required_fr, &mut required_bytes)
        .map_err(|e| ZkError::SerializationError(e.to_string()))?;

    Ok(ZkProof {
        proof_type: ZkProofType::KycStatus,
        proof_bytes: hex::encode(&proof_bytes),
        public_inputs: vec![hex::encode(&required_bytes)],
        bound_attribute: None,
        attribute_leaf_hash: None,
    })
}

/// Verify a KYC status proof with a provided prepared verification key
pub fn verify(
    pvk: &PreparedVerifyingKey<Bls12_381>,
    zk_proof: &ZkProof,
) -> Result<bool, ZkError> {
    let proof_bytes =
        hex::decode(&zk_proof.proof_bytes).map_err(|e| ZkError::VerificationFailed(e.to_string()))?;

    let proof: ark_groth16::Proof<Bls12_381> =
        CanonicalDeserialize::deserialize_compressed(&proof_bytes[..])
            .map_err(|e| ZkError::VerificationFailed(e.to_string()))?;

    let mut public_inputs = Vec::new();
    for input_hex in &zk_proof.public_inputs {
        let input_bytes =
            hex::decode(input_hex).map_err(|e| ZkError::VerificationFailed(e.to_string()))?;
        let fr: Fr = CanonicalDeserialize::deserialize_compressed(&input_bytes[..])
            .map_err(|e| ZkError::VerificationFailed(e.to_string()))?;
        public_inputs.push(fr);
    }

    Groth16::<Bls12_381>::verify_with_processed_vk(pvk, &public_inputs, &proof)
        .map_err(|e| ZkError::VerificationFailed(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_kyc_level_sufficient() {
        let (pk, pvk) = setup().expect("Setup failed");

        // Prove level 3 >= 2
        let proof = prove(&pk, 3, 2).expect("Proof generation failed");
        assert_eq!(proof.proof_type, ZkProofType::KycStatus);

        let valid = verify(&pvk, &proof).expect("Verification failed");
        assert!(valid);
    }

    #[test]
    fn test_kyc_exact_level() {
        let (pk, pvk) = setup().expect("Setup failed");

        // Prove level 2 >= 2
        let proof = prove(&pk, 2, 2).expect("Proof generation failed");
        let valid = verify(&pvk, &proof).expect("Verification failed");
        assert!(valid);
    }

    #[test]
    fn test_kyc_insufficient_rejected() {
        let (pk, _) = setup().expect("Setup failed");

        // Level 1 < 2 should fail
        let result = prove(&pk, 1, 2);
        assert!(result.is_err());
    }
}
