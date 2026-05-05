//! Nationality predicate circuit — MiMC Merkle tree set membership
//!
//! Proves that a committed nationality value is a leaf in a Merkle tree of
//! allowed nationalities without revealing which specific nationality.
//!
//! Uses a depth-5 MiMC hash tree (algebraic hash native to BLS12-381 Fr).
//! Only 1 public input (Merkle root) instead of 27 country hashes — saves ~832 bytes.

use ark_bls12_381::{Bls12_381, Fr};
use ark_ff::PrimeField;
use ark_groth16::{Groth16, PreparedVerifyingKey, ProvingKey};
use ark_r1cs_std::{fields::fp::FpVar, prelude::*};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use ark_snark::SNARK;
use ark_std::rand::{rngs::OsRng, rngs::StdRng, SeedableRng};
use sha2::{Digest, Sha256};

use crate::error::ZkError;
use crate::pedersen;
use crate::proof::{ZkProof, ZkProofType};

/// Merkle tree depth — supports up to 32 countries (2^5)
pub const TREE_DEPTH: usize = 5;

/// Hash a country code to a field element
pub fn country_to_field(country_code: &str) -> Fr {
    let hash = Sha256::digest(country_code.as_bytes());
    Fr::from_be_bytes_mod_order(&hash)
}

/// Nationality Merkle membership circuit.
///
/// Public inputs:  [merkle_root]
/// Private inputs: [nationality, sibling_path[0..TREE_DEPTH], path_indices[0..TREE_DEPTH]]
#[derive(Clone)]
pub struct NationalityCircuit {
    /// Private: the actual nationality (as field element)
    pub nationality: Option<Fr>,
    /// Private: Merkle path siblings (bottom-up)
    pub merkle_path: Vec<Option<Fr>>,
    /// Private: path direction bits (0 = left child, 1 = right child)
    pub path_indices: Vec<Option<bool>>,
    /// Public: Merkle root
    pub merkle_root: Option<Fr>,
}

impl ConstraintSynthesizer<Fr> for NationalityCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        // Allocate private nationality witness
        let nat_var = FpVar::new_witness(cs.clone(), || {
            self.nationality.ok_or(SynthesisError::AssignmentMissing)
        })?;

        // Compute leaf = pedersen_hash(nationality, nationality)
        let mut current = pedersen::pedersen_hash_gadget(cs.clone(), &nat_var, &nat_var)?;

        // Walk up the Merkle tree
        for i in 0..TREE_DEPTH {
            let sibling = FpVar::new_witness(cs.clone(), || {
                self.merkle_path[i].ok_or(SynthesisError::AssignmentMissing)
            })?;

            let is_right = Boolean::new_witness(cs.clone(), || {
                self.path_indices[i].ok_or(SynthesisError::AssignmentMissing)
            })?;

            // If is_right: hash(sibling, current), else hash(current, sibling)
            let left = FpVar::conditionally_select(&is_right, &sibling, &current)?;
            let right = FpVar::conditionally_select(&is_right, &current, &sibling)?;

            current = pedersen::pedersen_hash_gadget(cs.clone(), &left, &right)?;
        }

        // Public input: merkle_root
        let root_var = FpVar::new_input(cs.clone(), || {
            self.merkle_root.ok_or(SynthesisError::AssignmentMissing)
        })?;

        // Enforce: computed root == public merkle_root
        current.enforce_equal(&root_var)?;

        Ok(())
    }
}

/// EU member state country codes
pub const EU_COUNTRIES: &[&str] = &[
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR",
    "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
    "PL", "PT", "RO", "SK", "SI", "ES", "SE",
];

/// Build a Merkle tree of country field elements.
/// Returns (root, all_paths) where each path entry is (sibling, is_right).
pub fn build_nationality_tree(countries: &[&str]) -> (Fr, Vec<Vec<(Fr, bool)>>) {
    let leaves: Vec<Fr> = countries
        .iter()
        .map(|c| {
            let f = country_to_field(c);
            // Leaf = pedersen_hash(nationality, nationality)
            pedersen::pedersen_hash_native(f, f)
        })
        .collect();

    pedersen::build_merkle_tree(&leaves, TREE_DEPTH)
}

/// Setup: generate proving and verification keys for the Merkle membership circuit
pub fn setup() -> Result<(ProvingKey<Bls12_381>, PreparedVerifyingKey<Bls12_381>), ZkError> {
    let circuit = NationalityCircuit {
        nationality: None,
        merkle_path: vec![None; TREE_DEPTH],
        path_indices: vec![None; TREE_DEPTH],
        merkle_root: None,
    };

    let (pk, vk) = Groth16::<Bls12_381>::circuit_specific_setup(circuit, &mut StdRng::seed_from_u64(0x0C3D_0003))
        .map_err(|e| ZkError::SetupFailed(e.to_string()))?;

    let pvk = Groth16::<Bls12_381>::process_vk(&vk)
        .map_err(|e| ZkError::SetupFailed(e.to_string()))?;

    Ok((pk, pvk))
}

/// Generate a proof that a nationality is in the allowed set using Merkle tree membership.
pub fn prove(
    pk: &ProvingKey<Bls12_381>,
    nationality: &str,
    allowed_countries: &[&str],
) -> Result<ZkProof, ZkError> {
    let nat_field = country_to_field(nationality);

    // Find nationality index in the set
    let idx = allowed_countries
        .iter()
        .position(|&c| c == nationality)
        .ok_or_else(|| {
            ZkError::InvalidInput(format!("Nationality '{}' not in allowed set", nationality))
        })?;

    // Build Merkle tree and get path for this nationality
    let (root, all_paths) = build_nationality_tree(allowed_countries);
    let path = &all_paths[idx];

    let circuit = NationalityCircuit {
        nationality: Some(nat_field),
        merkle_path: path.iter().map(|(s, _)| Some(*s)).collect(),
        path_indices: path.iter().map(|(_, b)| Some(*b)).collect(),
        merkle_root: Some(root),
    };

    let proof = Groth16::<Bls12_381>::prove(pk, circuit, &mut OsRng)
        .map_err(|e| ZkError::ProofGenerationFailed(e.to_string()))?;

    // Serialize proof
    let mut proof_bytes = Vec::new();
    CanonicalSerialize::serialize_compressed(&proof, &mut proof_bytes)
        .map_err(|e| ZkError::SerializationError(e.to_string()))?;

    // Single public input: merkle_root
    let mut root_bytes = Vec::new();
    CanonicalSerialize::serialize_compressed(&root, &mut root_bytes)
        .map_err(|e| ZkError::SerializationError(e.to_string()))?;

    Ok(ZkProof {
        proof_type: ZkProofType::Nationality,
        proof_bytes: hex::encode(&proof_bytes),
        public_inputs: vec![hex::encode(&root_bytes)],
        bound_attribute: None,
        attribute_leaf_hash: None,
    })
}

/// Verify a nationality set membership proof
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
    use crate::{get_pk, get_pvk};

    #[test]
    fn test_eu_nationality_proof() {
        let countries = &["NL", "DE", "FR"];
        let pk = get_pk(&ZkProofType::Nationality);
        let pvk = get_pvk(&ZkProofType::Nationality);

        // Prove NL is in {NL, DE, FR}
        let proof = prove(pk, "NL", countries).expect("Proof generation failed");
        assert_eq!(proof.proof_type, ZkProofType::Nationality);
        // Should have exactly 1 public input (merkle root)
        assert_eq!(proof.public_inputs.len(), 1);

        let valid = verify(pvk, &proof).expect("Verification failed");
        assert!(valid);
    }

    #[test]
    fn test_non_member_rejected() {
        let countries = &["NL", "DE", "FR"];
        let pk = get_pk(&ZkProofType::Nationality);

        // US is not in {NL, DE, FR}
        let result = prove(pk, "US", countries);
        assert!(result.is_err());
    }

    #[test]
    fn test_full_eu_set() {
        let pk = get_pk(&ZkProofType::Nationality);
        let pvk = get_pvk(&ZkProofType::Nationality);

        // Prove DE is in full EU set
        let proof = prove(pk, "DE", EU_COUNTRIES).expect("Proof generation failed");
        assert_eq!(proof.public_inputs.len(), 1);

        let valid = verify(pvk, &proof).expect("Verification failed");
        assert!(valid);
    }
}
