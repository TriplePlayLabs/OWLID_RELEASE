//! Age range proof circuit
//!
//! Proves that a committed age value is >= a public threshold without revealing the exact age.
//! Circuit: given private `age` and public `threshold`, prove `age >= threshold`.

use ark_bls12_381::{Bls12_381, Fr};
use ark_groth16::{Groth16, PreparedVerifyingKey, Proof, ProvingKey};
use ark_r1cs_std::{fields::fp::FpVar, prelude::*};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use ark_snark::SNARK;
use ark_std::rand::{SeedableRng, rngs::OsRng, rngs::StdRng};

use crate::error::ZkError;
use crate::proof::{ZkProof, ZkProofType};

/// Age range circuit: proves age >= threshold
#[derive(Clone)]
pub struct AgeRangeCircuit {
    /// Private: the actual age
    pub age: Option<u64>,
    /// Public: the minimum age threshold
    pub threshold: Option<u64>,
}

impl ConstraintSynthesizer<Fr> for AgeRangeCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        // Allocate private age witness
        let age_var = FpVar::new_witness(cs.clone(), || {
            self.age
                .map(Fr::from)
                .ok_or(SynthesisError::AssignmentMissing)
        })?;

        // Allocate public threshold input
        let threshold_var = FpVar::new_input(cs.clone(), || {
            self.threshold
                .map(Fr::from)
                .ok_or(SynthesisError::AssignmentMissing)
        })?;

        // Compute difference = age - threshold
        let diff = &age_var - &threshold_var;

        // Enforce that difference is non-negative by decomposing into bits
        // A non-negative value in range [0, 2^8) is sufficient for age checks
        let bits = diff.to_bits_le()?;

        // Ensure the value fits in 8 bits (ages 0-255)
        // The high bits beyond 8 must be zero for a valid non-negative age difference
        for bit in bits.iter().skip(8) {
            bit.enforce_equal(&Boolean::FALSE)?;
        }

        Ok(())
    }
}

/// Setup: generate proving and verification keys
pub fn setup() -> Result<(ProvingKey<Bls12_381>, PreparedVerifyingKey<Bls12_381>), ZkError> {
    let circuit = AgeRangeCircuit {
        age: None,
        threshold: None,
    };

    let (pk, vk) = Groth16::<Bls12_381>::circuit_specific_setup(
        circuit,
        &mut StdRng::seed_from_u64(0x0A6E_0001),
    )
    .map_err(|e| ZkError::SetupFailed(e.to_string()))?;

    let pvk =
        Groth16::<Bls12_381>::process_vk(&vk).map_err(|e| ZkError::SetupFailed(e.to_string()))?;

    Ok((pk, pvk))
}

/// Generate a proof that `age >= threshold`
pub fn prove(pk: &ProvingKey<Bls12_381>, age: u64, threshold: u64) -> Result<ZkProof, ZkError> {
    if age < threshold {
        return Err(ZkError::PreconditionFailed);
    }

    let circuit = AgeRangeCircuit {
        age: Some(age),
        threshold: Some(threshold),
    };

    let proof = Groth16::<Bls12_381>::prove(pk, circuit, &mut OsRng)
        .map_err(|e| ZkError::ProofGenerationFailed(e.to_string()))?;

    // Serialize proof
    let mut proof_bytes = Vec::new();
    CanonicalSerialize::serialize_compressed(&proof, &mut proof_bytes)
        .map_err(|e| ZkError::SerializationError(e.to_string()))?;

    // Public input: threshold
    let threshold_fr = Fr::from(threshold);
    let mut threshold_bytes = Vec::new();
    CanonicalSerialize::serialize_compressed(&threshold_fr, &mut threshold_bytes)
        .map_err(|e| ZkError::SerializationError(e.to_string()))?;

    Ok(ZkProof {
        proof_type: ZkProofType::AgeRange,
        proof_bytes: hex::encode(&proof_bytes),
        public_inputs: vec![hex::encode(&threshold_bytes)],
        bound_attribute: None,
        attribute_leaf_hash: None,
    })
}

/// Verify an age range proof with a provided prepared verification key
pub fn verify(pvk: &PreparedVerifyingKey<Bls12_381>, zk_proof: &ZkProof) -> Result<bool, ZkError> {
    let proof_bytes = hex::decode(&zk_proof.proof_bytes)
        .map_err(|e| ZkError::VerificationFailed(e.to_string()))?;

    let proof: Proof<Bls12_381> = CanonicalDeserialize::deserialize_compressed(&proof_bytes[..])
        .map_err(|e| ZkError::VerificationFailed(e.to_string()))?;

    // Deserialize public inputs
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
    fn test_age_range_proof() {
        let (pk, pvk) = setup().expect("Setup failed");

        // Prove age 25 >= 18
        let proof = prove(&pk, 25, 18).expect("Proof generation failed");
        assert_eq!(proof.proof_type, ZkProofType::AgeRange);

        let valid = verify(&pvk, &proof).expect("Verification failed");
        assert!(valid);
    }

    #[test]
    fn test_age_range_exact_threshold() {
        let (pk, pvk) = setup().expect("Setup failed");

        // Prove age 18 >= 18
        let proof = prove(&pk, 18, 18).expect("Proof generation failed");
        let valid = verify(&pvk, &proof).expect("Verification failed");
        assert!(valid);
    }

    #[test]
    fn test_age_below_threshold_rejected() {
        let (pk, _) = setup().expect("Setup failed");

        // Age 16 < 18 should fail at proof generation
        let result = prove(&pk, 16, 18);
        assert!(result.is_err());
    }
}
