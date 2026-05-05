use crate::hash::{hash_attribute, hash_attribute_salted, hash_pair};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Merkle tree for document attributes
/// Implements the binary tree structure described in the architecture
#[derive(Debug, Clone)]
pub struct MerkleTree {
    /// The root hash of the tree
    root_hash: [u8; 32],
    /// Leaf hashes in order
    leaves: Vec<[u8; 32]>,
    /// Attribute keys in the same order as leaves
    attribute_keys: Vec<String>,
}

impl MerkleTree {
    /// Build a Merkle tree from document attributes
    /// BTreeMap provides deterministic ordering automatically
    pub fn from_attributes(attributes: &BTreeMap<String, serde_json::Value>) -> Self {
        let mut leaves = Vec::new();
        let mut attribute_keys = Vec::new();

        // BTreeMap iter() already provides sorted order
        for (key, value) in attributes.iter() {
            leaves.push(hash_attribute(key, value));
            attribute_keys.push(key.to_string());
        }

        let root_hash = Self::compute_root(&leaves);

        Self {
            root_hash,
            leaves,
            attribute_keys,
        }
    }

    /// Build a Merkle tree from document attributes with per-document salt
    /// Salt protects against rainbow table attacks on known attribute values
    pub fn from_attributes_salted(
        attributes: &BTreeMap<String, serde_json::Value>,
        salt: &str,
    ) -> Self {
        let mut leaves = Vec::new();
        let mut attribute_keys = Vec::new();

        for (key, value) in attributes.iter() {
            leaves.push(hash_attribute_salted(key, value, salt));
            attribute_keys.push(key.to_string());
        }

        let root_hash = Self::compute_root(&leaves);

        Self {
            root_hash,
            leaves,
            attribute_keys,
        }
    }

    /// Build a Merkle tree from pre-computed leaf hashes (for deserialization)
    pub fn from_leaf_hashes(
        leaf_hashes: &[(String, [u8; 32])],
    ) -> Self {
        let attribute_keys: Vec<String> = leaf_hashes.iter().map(|(k, _)| k.clone()).collect();
        let leaves: Vec<[u8; 32]> = leaf_hashes.iter().map(|(_, h)| *h).collect();
        let root_hash = Self::compute_root(&leaves);

        Self {
            root_hash,
            leaves,
            attribute_keys,
        }
    }

    /// Compute the Merkle root from leaf hashes
    fn compute_root(leaves: &[[u8; 32]]) -> [u8; 32] {
        if leaves.is_empty() {
            return [0u8; 32];
        }

        if leaves.len() == 1 {
            return leaves[0];
        }

        let mut current_level = leaves.to_vec();

        while current_level.len() > 1 {
            let mut next_level = Vec::new();

            for i in (0..current_level.len()).step_by(2) {
                if i + 1 < current_level.len() {
                    // Hash pairs
                    next_level.push(hash_pair(&current_level[i], &current_level[i + 1]));
                } else {
                    // Odd node, promote to next level
                    next_level.push(current_level[i]);
                }
            }

            current_level = next_level;
        }

        current_level[0]
    }

    /// Get the root hash
    pub fn root_hash(&self) -> &[u8; 32] {
        &self.root_hash
    }

    /// Get root hash as hex string
    pub fn root_hash_hex(&self) -> String {
        hex::encode(self.root_hash)
    }

    /// Get the leaf hashes
    pub fn leaves(&self) -> &[[u8; 32]] {
        &self.leaves
    }

    /// Get the leaf hash for a specific attribute key
    pub fn leaf_hash_hex(&self, key: &str) -> Option<String> {
        self.attribute_keys
            .iter()
            .position(|k| k == key)
            .map(|pos| hex::encode(self.leaves[pos]))
    }

    /// Generate a proof of inclusion for specific attributes
    pub fn generate_proof(&self, attribute_keys: &[String]) -> Result<MerkleProof, String> {
        let mut proof_leaves = Vec::new();
        let mut indices = Vec::new();

        // Find the indices of requested attributes
        for key in attribute_keys {
            if let Some(pos) = self.attribute_keys.iter().position(|k| k == key) {
                indices.push(pos);
                proof_leaves.push(ProofLeaf {
                    key: key.clone(),
                    hash: self.leaves[pos],
                    position: pos, // Store the original position
                });
            } else {
                return Err(format!("Attribute '{}' not found in tree", key));
            }
        }

        // Compute sibling hashes needed for verification
        let sibling_hashes = self.compute_sibling_hashes(&indices);

        Ok(MerkleProof {
            root_hash: self.root_hash,
            proof_leaves,
            sibling_hashes,
        })
    }

    /// Compute the sibling hashes needed to verify a set of leaves
    fn compute_sibling_hashes(&self, indices: &[usize]) -> Vec<SiblingHash> {
        let mut siblings = Vec::new();
        let mut current_level = self.leaves.clone();
        let mut current_indices = indices.to_vec();
        let mut level = 0;

        while current_level.len() > 1 {
            let mut next_level = Vec::new();
            let mut next_indices = Vec::new();
            let mut seen_in_level = std::collections::HashSet::new();

            for &idx in &current_indices {
                seen_in_level.insert(idx);
            }

            for i in (0..current_level.len()).step_by(2) {
                let left_included = seen_in_level.contains(&i);
                let right_included =
                    i + 1 < current_level.len() && seen_in_level.contains(&(i + 1));

                if left_included || right_included {
                    // Add sibling if only one side is included
                    if left_included && !right_included && i + 1 < current_level.len() {
                        siblings.push(SiblingHash {
                            level,
                            position: i + 1,
                            hash: current_level[i + 1],
                        });
                    } else if right_included && !left_included {
                        siblings.push(SiblingHash {
                            level,
                            position: i,
                            hash: current_level[i],
                        });
                    }

                    next_indices.push(next_level.len());
                }

                if i + 1 < current_level.len() {
                    next_level.push(hash_pair(&current_level[i], &current_level[i + 1]));
                } else {
                    next_level.push(current_level[i]);
                }
            }

            current_level = next_level;
            current_indices = next_indices;
            level += 1;
        }

        siblings
    }
}

/// A proof of inclusion for specific attributes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MerkleProof {
    #[serde(with = "hex_array")]
    root_hash: [u8; 32],
    proof_leaves: Vec<ProofLeaf>,
    sibling_hashes: Vec<SiblingHash>,
}

impl MerkleProof {
    /// Verify the proof against provided attribute values
    /// This reconstructs the Merkle root from the disclosed attributes and sibling hashes
    pub fn verify(&self, attributes: &BTreeMap<String, serde_json::Value>) -> bool {
        self.verify_with_salt(attributes, None)
    }

    /// Verify the proof against provided attribute values with optional salt
    pub fn verify_with_salt(
        &self,
        attributes: &BTreeMap<String, serde_json::Value>,
        salt: Option<&str>,
    ) -> bool {
        // Step 1: Validate that all provided attributes match their hashes
        for leaf in &self.proof_leaves {
            if let Some(value) = attributes.get(&leaf.key) {
                let computed_hash = match salt {
                    Some(s) => hash_attribute_salted(&leaf.key, value, s),
                    None => hash_attribute(&leaf.key, value),
                };
                if computed_hash != leaf.hash {
                    return false;
                }
            } else {
                return false;
            }
        }

        // Step 2: Reconstruct the Merkle root from the proof
        self.reconstruct_root_matches()
    }

    /// Verify proof with both disclosed attributes (re-hash values) and
    /// committed attributes (pre-computed leaf hashes, no value revealed).
    pub fn verify_with_commitments(
        &self,
        disclosed: &BTreeMap<String, serde_json::Value>,
        committed: &BTreeMap<String, String>, // attr name → leaf hash hex
        salt: Option<&str>,
    ) -> bool {
        // Step 1: Validate all proof leaves match either disclosed or committed
        for leaf in &self.proof_leaves {
            if let Some(value) = disclosed.get(&leaf.key) {
                // Disclosed attribute: re-hash and compare
                let computed_hash = match salt {
                    Some(s) => hash_attribute_salted(&leaf.key, value, s),
                    None => hash_attribute(&leaf.key, value),
                };
                if computed_hash != leaf.hash {
                    return false;
                }
            } else if let Some(leaf_hash_hex) = committed.get(&leaf.key) {
                // Committed attribute: compare hex leaf hash directly
                let Ok(hash_bytes) = hex::decode(leaf_hash_hex) else {
                    return false;
                };
                let Ok(hash_arr): Result<[u8; 32], _> = hash_bytes.try_into() else {
                    return false;
                };
                if hash_arr != leaf.hash {
                    return false;
                }
            } else {
                // Proof leaf not accounted for
                return false;
            }
        }

        // Step 2: Reconstruct the Merkle root from the proof
        self.reconstruct_root_matches()
    }

    /// Climb the partial tree built from disclosed/committed leaf hashes plus
    /// sibling hashes until we land on a single hash at position 0, then
    /// compare it to the claimed root.
    ///
    /// Used by both `verify_with_salt` and `verify_with_commitments` after
    /// they've validated the leaf hashes.
    fn reconstruct_root_matches(&self) -> bool {
        use std::collections::HashMap;

        let mut current_level: HashMap<usize, [u8; 32]> = HashMap::new();
        for leaf in &self.proof_leaves {
            current_level.insert(leaf.position, leaf.hash);
        }

        let mut sibling_map: HashMap<usize, Vec<&SiblingHash>> = HashMap::new();
        for sibling in &self.sibling_hashes {
            sibling_map.entry(sibling.level).or_default().push(sibling);
        }

        // Continue while either: more than one node at this level, more
        // siblings to absorb above, or our single node hasn't yet propagated
        // up to position 0 (the root). The earlier loop only checked the
        // first two conditions and exited prematurely when disclosed leaves
        // collapsed to a single hash at a non-root position several levels
        // below the actual root, returning that intermediate hash as if it
        // were the root.
        let mut level = 0usize;
        while current_level.len() > 1
            || sibling_map.contains_key(&level)
            || (current_level.len() == 1 && !current_level.contains_key(&0))
        {
            let mut next_level: HashMap<usize, [u8; 32]> = HashMap::new();
            let siblings_at_level = sibling_map.get(&level).cloned().unwrap_or_default();
            let mut all_nodes: HashMap<usize, [u8; 32]> = current_level.clone();
            for sibling in &siblings_at_level {
                all_nodes.insert(sibling.position, sibling.hash);
            }
            let max_pos = all_nodes.keys().max().cloned().unwrap_or(0);
            for i in (0..=max_pos).step_by(2) {
                if let Some(left_hash) = all_nodes.get(&i) {
                    if let Some(right_hash) = all_nodes.get(&(i + 1)) {
                        next_level.insert(i / 2, hash_pair(left_hash, right_hash));
                    } else {
                        next_level.insert(i / 2, *left_hash);
                    }
                } else if let Some(right_hash) = all_nodes.get(&(i + 1)) {
                    next_level.insert(i / 2, *right_hash);
                }
            }
            current_level = next_level;
            level += 1;
            if level > 100 {
                return false;
            }
        }

        if current_level.len() != 1 {
            return false;
        }
        let Some(reconstructed) = current_level.get(&0) else {
            return false;
        };
        reconstructed == &self.root_hash
    }

    pub fn root_hash(&self) -> &[u8; 32] {
        &self.root_hash
    }

    pub fn root_hash_hex(&self) -> String {
        hex::encode(self.root_hash)
    }

    pub fn proof_leaves(&self) -> &[ProofLeaf] {
        &self.proof_leaves
    }

    pub fn sibling_hashes(&self) -> &[SiblingHash] {
        &self.sibling_hashes
    }

    /// Reconstruct a MerkleProof from its parts
    pub fn from_parts(
        root_hash: [u8; 32],
        proof_leaves: Vec<ProofLeaf>,
        sibling_hashes: Vec<SiblingHash>,
    ) -> Self {
        Self {
            root_hash,
            proof_leaves,
            sibling_hashes,
        }
    }
}

/// A single leaf in a proof
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProofLeaf {
    key: String,
    #[serde(with = "hex_array")]
    hash: [u8; 32],
    position: usize, // Original position in the tree
}

impl ProofLeaf {
    /// Create a new proof leaf
    pub fn new(key: String, hash: [u8; 32], position: usize) -> Self {
        Self { key, hash, position }
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn hash(&self) -> &[u8; 32] {
        &self.hash
    }

    pub fn position(&self) -> usize {
        self.position
    }
}

/// Sibling hash for proof verification
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiblingHash {
    level: usize,
    position: usize,
    #[serde(with = "hex_array")]
    hash: [u8; 32],
}

impl SiblingHash {
    /// Create a new sibling hash
    pub fn new(level: usize, position: usize, hash: [u8; 32]) -> Self {
        Self { level, position, hash }
    }

    /// Get the level
    pub fn level(&self) -> usize {
        self.level
    }

    /// Get the position
    pub fn position(&self) -> usize {
        self.position
    }

    /// Get the hash
    pub fn hash(&self) -> &[u8; 32] {
        &self.hash
    }
}

// Helper module for hex serialization of [u8; 32]
mod hex_array {
    use serde::{Deserializer, Serializer};

    pub fn serialize<S>(bytes: &[u8; 32], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&hex::encode(bytes))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<[u8; 32], D::Error>
    where
        D: Deserializer<'de>,
    {
        use serde::Deserialize;
        let hex_str = String::deserialize(deserializer)?;
        let bytes = hex::decode(hex_str).map_err(serde::de::Error::custom)?;
        let array: [u8; 32] = bytes
            .try_into()
            .map_err(|_| serde::de::Error::custom("Invalid hash length"))?;
        Ok(array)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_merkle_tree_creation() {
        let mut attrs = BTreeMap::new();
        attrs.insert("name".to_string(), json!("John Doe"));
        attrs.insert("age".to_string(), json!(30));

        let tree = MerkleTree::from_attributes(&attrs);
        assert_ne!(tree.root_hash(), &[0u8; 32]);
    }

    #[test]
    fn test_proof_generation() {
        let mut attrs = BTreeMap::new();
        attrs.insert("name".to_string(), json!("John Doe"));
        attrs.insert("age".to_string(), json!(30));
        attrs.insert("country".to_string(), json!("US"));

        let tree = MerkleTree::from_attributes(&attrs);
        let proof = tree.generate_proof(&["name".to_string()]).unwrap();

        assert_eq!(proof.root_hash(), tree.root_hash());
    }

    #[test]
    fn test_proof_verification() {
        let mut attrs = BTreeMap::new();
        attrs.insert("name".to_string(), json!("John Doe"));
        attrs.insert("age".to_string(), json!(30));

        let tree = MerkleTree::from_attributes(&attrs);
        let proof = tree.generate_proof(&["name".to_string()]).unwrap();

        let mut verify_attrs = BTreeMap::new();
        verify_attrs.insert("name".to_string(), json!("John Doe"));

        assert!(proof.verify(&verify_attrs));
    }

    #[test]
    fn test_proof_verification_fails_wrong_value() {
        let mut attrs = BTreeMap::new();
        attrs.insert("name".to_string(), json!("John Doe"));
        attrs.insert("age".to_string(), json!(30));

        let tree = MerkleTree::from_attributes(&attrs);
        let proof = tree.generate_proof(&["name".to_string()]).unwrap();

        let mut verify_attrs = BTreeMap::new();
        verify_attrs.insert("name".to_string(), json!("Jane Doe"));

        assert!(!proof.verify(&verify_attrs));
    }

    #[test]
    fn test_proof_verification_with_multiple_attributes() {
        let mut attrs = BTreeMap::new();
        attrs.insert("name".to_string(), json!("John Doe"));
        attrs.insert("age".to_string(), json!(30));
        attrs.insert("country".to_string(), json!("US"));
        attrs.insert("city".to_string(), json!("New York"));

        let tree = MerkleTree::from_attributes(&attrs);

        // Prove only name and country (selective disclosure)
        let proof = tree.generate_proof(&["name".to_string(), "country".to_string()]).unwrap();

        let mut verify_attrs = BTreeMap::new();
        verify_attrs.insert("name".to_string(), json!("John Doe"));
        verify_attrs.insert("country".to_string(), json!("US"));

        assert!(proof.verify(&verify_attrs));
    }

    #[test]
    fn test_proof_verification_rejects_forged_proof() {
        // Create a tree with some attributes
        let mut attrs = BTreeMap::new();
        attrs.insert("name".to_string(), json!("John Doe"));
        attrs.insert("age".to_string(), json!(30));
        attrs.insert("country".to_string(), json!("US"));

        let tree = MerkleTree::from_attributes(&attrs);

        // Generate a valid proof for "name"
        let mut proof = tree.generate_proof(&["name".to_string()]).unwrap();

        // Create a different tree with different attributes
        let mut different_attrs = BTreeMap::new();
        different_attrs.insert("name".to_string(), json!("John Doe"));
        different_attrs.insert("age".to_string(), json!(40)); // Different age
        different_attrs.insert("country".to_string(), json!("Canada")); // Different country

        let different_tree = MerkleTree::from_attributes(&different_attrs);

        // Try to use the proof from the first tree with the root from a different tree
        // This simulates an attacker trying to claim attributes from a different document
        proof.root_hash = *different_tree.root_hash();

        let mut verify_attrs = BTreeMap::new();
        verify_attrs.insert("name".to_string(), json!("John Doe"));

        // This should FAIL because the sibling hashes don't match the forged root
        assert!(!proof.verify(&verify_attrs));
    }

    #[test]
    fn test_large_tree_proof_verification() {
        let mut attrs = BTreeMap::new();
        // Create a larger tree to test with more levels
        for i in 0..10 {
            attrs.insert(format!("attr{}", i), json!(format!("value{}", i)));
        }

        let tree = MerkleTree::from_attributes(&attrs);

        // Prove only a few attributes
        let proof = tree.generate_proof(&[
            "attr0".to_string(),
            "attr5".to_string(),
            "attr9".to_string(),
        ]).unwrap();

        let mut verify_attrs = BTreeMap::new();
        verify_attrs.insert("attr0".to_string(), json!("value0"));
        verify_attrs.insert("attr5".to_string(), json!("value5"));
        verify_attrs.insert("attr9".to_string(), json!("value9"));

        assert!(proof.verify(&verify_attrs));
    }
}
