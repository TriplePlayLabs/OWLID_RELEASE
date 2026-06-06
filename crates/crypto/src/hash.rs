use sha2::{Digest, Sha256};

/// Hash algorithm selection
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HashAlgorithm {
    /// SHA-256 (FIPS compliant, universal compatibility)
    #[default]
    Sha256,
    /// Blake3 (10x faster, modern design)
    Blake3,
}

/// Hash a single attribute (key-value pair) as per the architecture specification
/// Format: Hash(JSON.stringify({key: value}))
/// Uses SHA-256 by default for FIPS compliance
pub fn hash_attribute(key: &str, value: &serde_json::Value) -> [u8; 32] {
    hash_attribute_with_algorithm(key, value, HashAlgorithm::default())
}

/// Hash a single attribute with a per-document salt for rainbow table protection
/// Format: Hash(salt || JSON.stringify({key: value}))
pub fn hash_attribute_salted(key: &str, value: &serde_json::Value, salt: &str) -> [u8; 32] {
    hash_attribute_salted_with_algorithm(key, value, salt, HashAlgorithm::default())
}

/// Hash a single attribute with a specified algorithm
pub fn hash_attribute_with_algorithm(
    key: &str,
    value: &serde_json::Value,
    algorithm: HashAlgorithm,
) -> [u8; 32] {
    let json_str = serde_json::json!({key: value}).to_string();
    hash_bytes_with_algorithm(json_str.as_bytes(), algorithm)
}

/// Hash a single attribute with salt and specified algorithm
pub fn hash_attribute_salted_with_algorithm(
    key: &str,
    value: &serde_json::Value,
    salt: &str,
    algorithm: HashAlgorithm,
) -> [u8; 32] {
    let json_str = serde_json::json!({key: value}).to_string();
    let salted = format!("{}{}", salt, json_str);
    hash_bytes_with_algorithm(salted.as_bytes(), algorithm)
}

/// Generate a random 32-byte salt as hex string
pub fn generate_salt() -> String {
    use rand::RngCore;
    let mut salt_bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut salt_bytes);
    hex::encode(salt_bytes)
}

/// Hash two hashes together (for Merkle tree internal nodes)
/// Uses SHA-256 by default for FIPS compliance
pub fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    hash_pair_with_algorithm(left, right, HashAlgorithm::default())
}

/// Hash two hashes together with a specified algorithm
pub fn hash_pair_with_algorithm(
    left: &[u8; 32],
    right: &[u8; 32],
    algorithm: HashAlgorithm,
) -> [u8; 32] {
    match algorithm {
        HashAlgorithm::Sha256 => {
            let mut hasher = Sha256::new();
            hasher.update(left);
            hasher.update(right);
            hasher.finalize().into()
        }
        HashAlgorithm::Blake3 => {
            let mut hasher = blake3::Hasher::new();
            hasher.update(left);
            hasher.update(right);
            *hasher.finalize().as_bytes()
        }
    }
}

/// Hash a single value (for leaf nodes)
/// Uses SHA-256 by default for FIPS compliance
pub fn hash_bytes(data: &[u8]) -> [u8; 32] {
    hash_bytes_with_algorithm(data, HashAlgorithm::default())
}

/// Hash a single value with a specified algorithm
pub fn hash_bytes_with_algorithm(data: &[u8], algorithm: HashAlgorithm) -> [u8; 32] {
    match algorithm {
        HashAlgorithm::Sha256 => {
            let mut hasher = Sha256::new();
            hasher.update(data);
            hasher.finalize().into()
        }
        HashAlgorithm::Blake3 => {
            let mut hasher = blake3::Hasher::new();
            hasher.update(data);
            *hasher.finalize().as_bytes()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_hash_attribute_default() {
        let hash = hash_attribute("name", &json!("John Doe"));
        assert_eq!(hash.len(), 32);
    }

    #[test]
    fn test_hash_attribute_sha256() {
        let hash = hash_attribute_with_algorithm("name", &json!("John Doe"), HashAlgorithm::Sha256);
        assert_eq!(hash.len(), 32);
    }

    #[test]
    fn test_hash_pair_default() {
        let left = [0u8; 32];
        let right = [1u8; 32];
        let hash = hash_pair(&left, &right);
        assert_eq!(hash.len(), 32);
    }

    #[test]
    fn test_hash_pair_sha256() {
        let left = [0u8; 32];
        let right = [1u8; 32];
        let hash = hash_pair_with_algorithm(&left, &right, HashAlgorithm::Sha256);
        assert_eq!(hash.len(), 32);
    }

    #[test]
    fn test_algorithms_produce_different_hashes() {
        let data = b"test data";
        let blake3_hash = hash_bytes_with_algorithm(data, HashAlgorithm::Blake3);
        let sha256_hash = hash_bytes_with_algorithm(data, HashAlgorithm::Sha256);

        // Same input, different algorithms should produce different outputs
        assert_ne!(blake3_hash, sha256_hash);
    }

    #[test]
    fn test_default_algorithm_is_sha256() {
        assert_eq!(HashAlgorithm::default(), HashAlgorithm::Sha256);
    }

    #[test]
    fn test_blake3_deterministic() {
        let data = b"deterministic test";
        let hash1 = hash_bytes_with_algorithm(data, HashAlgorithm::Blake3);
        let hash2 = hash_bytes_with_algorithm(data, HashAlgorithm::Blake3);
        assert_eq!(hash1, hash2);
    }
}
