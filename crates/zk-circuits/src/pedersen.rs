//! Algebraic hash for in-circuit Merkle trees over BLS12-381 Fr.
//!
//! Uses a MiMC-like permutation (x^5 rounds with round constants) that is
//! native to the BLS12-381 scalar field. Each hash costs ~300 R1CS constraints
//! (vs ~250,000 for Pedersen/JubJub scalar multiplication, or ~25,000 for SHA-256).
//!
//! The hash maps two Fr elements to one Fr element, suitable for binary Merkle trees.

use ark_bls12_381::Fr;
use ark_ff::{Field, PrimeField};
use ark_r1cs_std::{fields::fp::FpVar, prelude::*};
use ark_relations::r1cs::{ConstraintSystemRef, SynthesisError};
use sha2::{Digest, Sha256};

/// Number of MiMC rounds. 57 rounds provides ~128 bits of security for BLS12-381.
const NUM_ROUNDS: usize = 57;

/// Deterministically derived round constants, lazily initialized.
static ROUND_CONSTANTS: std::sync::LazyLock<Vec<Fr>> = std::sync::LazyLock::new(|| {
    let mut constants = Vec::with_capacity(NUM_ROUNDS);
    for i in 0..NUM_ROUNDS {
        let mut hasher = Sha256::new();
        hasher.update(b"NightID_MiMC_round_v1");
        hasher.update((i as u64).to_le_bytes());
        let hash = hasher.finalize();
        constants.push(Fr::from_be_bytes_mod_order(&hash));
    }
    constants
});

/// Compute `mimc_hash(left, right)` natively (outside circuit).
///
/// MiMC sponge: absorb left and right into a permutation state.
pub fn pedersen_hash_native(left: Fr, right: Fr) -> Fr {
    let rc = &*ROUND_CONSTANTS;

    // MiMC Feistel: key = right, message = left
    let mut state = left;
    for c in rc.iter() {
        let t = state + *c + right;
        // x^5 permutation
        let t2 = t * t;
        let t4 = t2 * t2;
        state = t4 * t;
    }
    state + left + right
}

/// Build a Merkle tree from leaf field elements using the algebraic hash.
/// Returns (root, all_paths) where each path entry is (sibling, is_right).
pub fn build_merkle_tree(leaves: &[Fr], depth: usize) -> (Fr, Vec<Vec<(Fr, bool)>>) {
    let num_leaves = 1 << depth;
    assert!(leaves.len() <= num_leaves);

    // Pad leaves to full tree width with zeros
    let mut padded = leaves.to_vec();
    padded.resize(num_leaves, Fr::from(0u64));

    // Build tree bottom-up
    let mut levels: Vec<Vec<Fr>> = vec![padded];
    for _d in 0..depth {
        let prev = levels.last().unwrap();
        let mut next = Vec::with_capacity(prev.len() / 2);
        for pair in prev.chunks(2) {
            next.push(pedersen_hash_native(pair[0], pair[1]));
        }
        levels.push(next);
    }

    let root = levels[depth][0];

    // Compute paths for each original leaf
    let mut all_paths = Vec::new();
    for leaf_idx in 0..leaves.len() {
        let mut path = Vec::new();
        let mut idx = leaf_idx;
        for d in 0..depth {
            let sibling_idx = idx ^ 1;
            let is_right = (idx & 1) == 1;
            path.push((levels[d][sibling_idx], is_right));
            idx >>= 1;
        }
        all_paths.push(path);
    }

    (root, all_paths)
}

/// MiMC hash gadget for R1CS.
///
/// Takes two `FpVar<Fr>` inputs and returns `FpVar<Fr>`.
/// Cost: ~5 × NUM_ROUNDS = ~285 R1CS constraints.
pub fn pedersen_hash_gadget(
    _cs: ConstraintSystemRef<Fr>,
    left: &FpVar<Fr>,
    right: &FpVar<Fr>,
) -> Result<FpVar<Fr>, SynthesisError> {
    let rc = &*ROUND_CONSTANTS;

    let mut state = left.clone();
    for c in rc.iter() {
        let c_var = FpVar::constant(*c);
        let t = &state + &c_var + right;
        // x^5 = x^2 * x^2 * x
        let t2 = &t * &t;
        let t4 = &t2 * &t2;
        state = &t4 * &t;
    }
    Ok(&state + left + right)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_relations::r1cs::ConstraintSystem;

    #[test]
    fn test_hash_deterministic() {
        let a = Fr::from(42u64);
        let b = Fr::from(99u64);
        let h1 = pedersen_hash_native(a, b);
        let h2 = pedersen_hash_native(a, b);
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_hash_different_inputs() {
        let h1 = pedersen_hash_native(Fr::from(1u64), Fr::from(2u64));
        let h2 = pedersen_hash_native(Fr::from(2u64), Fr::from(1u64));
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_merkle_tree_build() {
        let leaves = vec![Fr::from(1u64), Fr::from(2u64), Fr::from(3u64)];
        let (root, paths) = build_merkle_tree(&leaves, 2);
        assert_eq!(paths.len(), 3);

        // Verify first leaf's path leads to root
        let mut current = leaves[0];
        for (sibling, is_right) in &paths[0] {
            current = if *is_right {
                pedersen_hash_native(*sibling, current)
            } else {
                pedersen_hash_native(current, *sibling)
            };
        }
        assert_eq!(current, root);
    }

    #[test]
    fn test_gadget_satisfies_and_matches_native() {
        let cs = ConstraintSystem::<Fr>::new_ref();
        let a = Fr::from(42u64);
        let b = Fr::from(99u64);

        let a_var = FpVar::new_witness(cs.clone(), || Ok(a)).unwrap();
        let b_var = FpVar::new_witness(cs.clone(), || Ok(b)).unwrap();

        let result = pedersen_hash_gadget(cs.clone(), &a_var, &b_var).unwrap();

        // Check that the gadget result matches the native computation
        let native = pedersen_hash_native(a, b);
        let expected = FpVar::new_witness(cs.clone(), || Ok(native)).unwrap();
        result.enforce_equal(&expected).unwrap();

        assert!(cs.is_satisfied().unwrap());
        println!("MiMC hash constraints: {}", cs.num_constraints());
    }
}
