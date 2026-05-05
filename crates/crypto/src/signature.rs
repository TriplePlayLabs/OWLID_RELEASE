use ed25519_dalek::{Signer as Ed25519Signer, SigningKey as Ed25519SigningKey, Verifier as Ed25519Verifier, VerifyingKey as Ed25519VerifyingKey};
use p256::ecdsa::{Signature as P256Signature, SigningKey as P256SigningKey, VerifyingKey as P256VerifyingKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum SignatureError {
    #[error("Invalid signature")]
    InvalidSignature,
    #[error("Invalid public key: {0}")]
    InvalidPublicKey(String),
    #[error("Invalid private key: {0}")]
    InvalidPrivateKey(String),
    #[error("Unsupported algorithm: {0}")]
    UnsupportedAlgorithm(String),
}

/// Signature algorithm type
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum SignatureAlgorithm {
    /// Ed25519 (fast, software-only)
    Ed25519,
    /// ECDSA P-256 (WebAuthn compatible)
    EcdsaP256,
}

/// Signing key pair supporting multiple algorithms
#[derive(Clone)]
pub struct KeyPair {
    algorithm: SignatureAlgorithm,
    ed25519_key: Option<Ed25519SigningKey>,
    p256_key: Option<P256SigningKey>,
}

impl KeyPair {
    /// Generate a new random key pair with Ed25519 (default)
    pub fn generate() -> Self {
        Self::generate_with_algorithm(SignatureAlgorithm::Ed25519)
    }

    /// Generate a new random key pair with specified algorithm
    pub fn generate_with_algorithm(algorithm: SignatureAlgorithm) -> Self {
        match algorithm {
            SignatureAlgorithm::Ed25519 => {
                let mut rng = rand::rngs::OsRng;
                let signing_key = Ed25519SigningKey::generate(&mut rng);
                Self {
                    algorithm,
                    ed25519_key: Some(signing_key),
                    p256_key: None,
                }
            }
            SignatureAlgorithm::EcdsaP256 => {
                let mut rng = rand::rngs::OsRng;
                let signing_key = P256SigningKey::random(&mut rng);
                Self {
                    algorithm,
                    ed25519_key: None,
                    p256_key: Some(signing_key),
                }
            }
        }
    }

    /// Create Ed25519 key from raw bytes (32 bytes)
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, SignatureError> {
        Self::from_bytes_with_algorithm(bytes, SignatureAlgorithm::Ed25519)
    }

    /// Create key from raw bytes with specified algorithm
    pub fn from_bytes_with_algorithm(
        bytes: &[u8],
        algorithm: SignatureAlgorithm,
    ) -> Result<Self, SignatureError> {
        match algorithm {
            SignatureAlgorithm::Ed25519 => {
                let signing_key = Ed25519SigningKey::from_bytes(bytes.try_into().map_err(|_| {
                    SignatureError::InvalidPrivateKey("Invalid Ed25519 key length".to_string())
                })?);
                Ok(Self {
                    algorithm,
                    ed25519_key: Some(signing_key),
                    p256_key: None,
                })
            }
            SignatureAlgorithm::EcdsaP256 => {
                let signing_key = P256SigningKey::from_bytes(bytes.into()).map_err(|e| {
                    SignatureError::InvalidPrivateKey(format!("Invalid P-256 key: {}", e))
                })?;
                Ok(Self {
                    algorithm,
                    ed25519_key: None,
                    p256_key: Some(signing_key),
                })
            }
        }
    }

    /// Sign a message
    ///
    /// # Panics
    /// Should not panic as the key is always initialized for the matching algorithm.
    pub fn sign(&self, message: &[u8]) -> Signature {
        match self.algorithm {
            SignatureAlgorithm::Ed25519 => {
                let key = self
                    .ed25519_key
                    .as_ref()
                    .expect("Ed25519 key must be set for Ed25519 algorithm");
                let sig = key.sign(message);
                Signature {
                    algorithm: SignatureAlgorithm::Ed25519,
                    bytes: sig.to_bytes().to_vec(),
                }
            }
            SignatureAlgorithm::EcdsaP256 => {
                use p256::ecdsa::signature::Signer;
                let key = self
                    .p256_key
                    .as_ref()
                    .expect("P-256 key must be set for EcdsaP256 algorithm");
                let sig: P256Signature = key.sign(message);
                Signature {
                    algorithm: SignatureAlgorithm::EcdsaP256,
                    bytes: sig.to_bytes().to_vec(),
                }
            }
        }
    }

    /// Get the public key
    pub fn public_key(&self) -> PublicKey {
        match self.algorithm {
            SignatureAlgorithm::Ed25519 => PublicKey {
                algorithm: SignatureAlgorithm::Ed25519,
                ed25519_key: Some(
                    self.ed25519_key
                        .as_ref()
                        .expect("Ed25519 key must be set for Ed25519 algorithm")
                        .verifying_key(),
                ),
                p256_key: None,
            },
            SignatureAlgorithm::EcdsaP256 => PublicKey {
                algorithm: SignatureAlgorithm::EcdsaP256,
                ed25519_key: None,
                p256_key: Some(
                    *self
                        .p256_key
                        .as_ref()
                        .expect("P-256 key must be set for EcdsaP256 algorithm")
                        .verifying_key(),
                ),
            },
        }
    }

    /// Get the algorithm
    pub fn algorithm(&self) -> SignatureAlgorithm {
        self.algorithm
    }

    /// Export private key bytes
    pub fn to_bytes(&self) -> Vec<u8> {
        match self.algorithm {
            SignatureAlgorithm::Ed25519 => self
                .ed25519_key
                .as_ref()
                .expect("Ed25519 key must be set")
                .to_bytes()
                .to_vec(),
            SignatureAlgorithm::EcdsaP256 => self
                .p256_key
                .as_ref()
                .expect("P-256 key must be set")
                .to_bytes()
                .to_vec(),
        }
    }
}

/// Public key for verification
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicKey {
    algorithm: SignatureAlgorithm,
    #[serde(with = "ed25519_key_serde")]
    ed25519_key: Option<Ed25519VerifyingKey>,
    #[serde(with = "p256_key_serde")]
    p256_key: Option<P256VerifyingKey>,
}

impl PublicKey {
    /// Create Ed25519 key from raw bytes (32 bytes) - for backward compatibility
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, SignatureError> {
        Self::from_bytes_with_algorithm(bytes, SignatureAlgorithm::Ed25519)
    }

    /// Create key from raw bytes with specified algorithm
    pub fn from_bytes_with_algorithm(
        bytes: &[u8],
        algorithm: SignatureAlgorithm,
    ) -> Result<Self, SignatureError> {
        match algorithm {
            SignatureAlgorithm::Ed25519 => {
                let verifying_key = Ed25519VerifyingKey::from_bytes(
                    bytes.try_into().map_err(|_| {
                        SignatureError::InvalidPublicKey("Invalid Ed25519 key length".to_string())
                    })?,
                )
                .map_err(|e| SignatureError::InvalidPublicKey(e.to_string()))?;
                Ok(Self {
                    algorithm,
                    ed25519_key: Some(verifying_key),
                    p256_key: None,
                })
            }
            SignatureAlgorithm::EcdsaP256 => {
                let verifying_key = P256VerifyingKey::from_sec1_bytes(bytes)
                    .map_err(|e| SignatureError::InvalidPublicKey(format!("Invalid P-256 key: {}", e)))?;
                Ok(Self {
                    algorithm,
                    ed25519_key: None,
                    p256_key: Some(verifying_key),
                })
            }
        }
    }

    /// Verify a signature
    pub fn verify(&self, message: &[u8], signature: &Signature) -> Result<(), SignatureError> {
        if self.algorithm != signature.algorithm {
            return Err(SignatureError::InvalidSignature);
        }

        match self.algorithm {
            SignatureAlgorithm::Ed25519 => {
                let sig = ed25519_dalek::Signature::from_slice(&signature.bytes)
                    .map_err(|_| SignatureError::InvalidSignature)?;
                let key = self.ed25519_key.as_ref().ok_or_else(|| {
                    SignatureError::InvalidPublicKey("Ed25519 key not initialized".to_string())
                })?;
                key.verify(message, &sig)
                    .map_err(|_| SignatureError::InvalidSignature)
            }
            SignatureAlgorithm::EcdsaP256 => {
                use p256::ecdsa::signature::Verifier;
                let sig = P256Signature::from_slice(&signature.bytes)
                    .map_err(|_| SignatureError::InvalidSignature)?;
                let key = self.p256_key.as_ref().ok_or_else(|| {
                    SignatureError::InvalidPublicKey("P-256 key not initialized".to_string())
                })?;
                key.verify(message, &sig)
                    .map_err(|_| SignatureError::InvalidSignature)
            }
        }
    }

    /// Get the algorithm
    pub fn algorithm(&self) -> SignatureAlgorithm {
        self.algorithm
    }

    /// Export to bytes
    pub fn to_bytes(&self) -> Vec<u8> {
        match self.algorithm {
            SignatureAlgorithm::Ed25519 => self
                .ed25519_key
                .as_ref()
                .expect("Ed25519 key must be set")
                .to_bytes()
                .to_vec(),
            SignatureAlgorithm::EcdsaP256 => self
                .p256_key
                .as_ref()
                .expect("P-256 key must be set")
                .to_encoded_point(false)
                .as_bytes()
                .to_vec(),
        }
    }

    /// Export to hex string
    pub fn to_hex(&self) -> String {
        hex::encode(self.to_bytes())
    }

    /// Import from hex string (defaults to Ed25519)
    pub fn from_hex(hex_str: &str) -> Result<Self, SignatureError> {
        Self::from_hex_with_algorithm(hex_str, SignatureAlgorithm::Ed25519)
    }

    /// Import from hex string with specified algorithm
    pub fn from_hex_with_algorithm(
        hex_str: &str,
        algorithm: SignatureAlgorithm,
    ) -> Result<Self, SignatureError> {
        let bytes = hex::decode(hex_str)
            .map_err(|e| SignatureError::InvalidPublicKey(format!("Invalid hex: {}", e)))?;
        Self::from_bytes_with_algorithm(&bytes, algorithm)
    }
}

/// Digital signature
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Signature {
    algorithm: SignatureAlgorithm,
    #[serde(with = "hex::serde")]
    bytes: Vec<u8>,
}

impl Signature {
    /// Create a signature from algorithm and raw bytes
    pub fn from_parts(algorithm: SignatureAlgorithm, bytes: Vec<u8>) -> Self {
        Self { algorithm, bytes }
    }

    /// Get the algorithm
    pub fn algorithm(&self) -> SignatureAlgorithm {
        self.algorithm
    }

    /// Get the raw signature bytes
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Export to hex string
    pub fn to_hex(&self) -> String {
        hex::encode(&self.bytes)
    }

    /// Import from hex string (defaults to Ed25519)
    pub fn from_hex(hex_str: &str) -> Result<Self, SignatureError> {
        Self::from_hex_with_algorithm(hex_str, SignatureAlgorithm::Ed25519)
    }

    /// Import from hex string with specified algorithm
    pub fn from_hex_with_algorithm(
        hex_str: &str,
        algorithm: SignatureAlgorithm,
    ) -> Result<Self, SignatureError> {
        let bytes = hex::decode(hex_str).map_err(|_e| SignatureError::InvalidSignature)?;

        // Validate length based on algorithm
        match algorithm {
            SignatureAlgorithm::Ed25519 => {
                if bytes.len() != 64 {
                    return Err(SignatureError::InvalidSignature);
                }
            }
            SignatureAlgorithm::EcdsaP256 => {
                if bytes.len() != 64 {
                    return Err(SignatureError::InvalidSignature);
                }
            }
        }

        Ok(Self { algorithm, bytes })
    }
}

// Custom serde for Ed25519 keys
mod ed25519_key_serde {
    use super::*;
    use serde::{Deserializer, Serializer};

    pub fn serialize<S>(key: &Option<Ed25519VerifyingKey>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match key {
            Some(k) => serializer.serialize_str(&hex::encode(k.to_bytes())),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<Ed25519VerifyingKey>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let opt: Option<String> = Option::deserialize(deserializer)?;
        match opt {
            Some(hex_str) => {
                let bytes = hex::decode(hex_str).map_err(serde::de::Error::custom)?;
                let key_bytes: [u8; 32] = bytes
                    .try_into()
                    .map_err(|_| serde::de::Error::custom("Invalid Ed25519 key length"))?;
                let key = Ed25519VerifyingKey::from_bytes(&key_bytes)
                    .map_err(serde::de::Error::custom)?;
                Ok(Some(key))
            }
            None => Ok(None),
        }
    }
}

// Custom serde for P-256 keys
mod p256_key_serde {
    use super::*;
    use serde::{Deserializer, Serializer};

    pub fn serialize<S>(key: &Option<P256VerifyingKey>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match key {
            Some(k) => serializer.serialize_str(&hex::encode(k.to_encoded_point(false).as_bytes())),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<P256VerifyingKey>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let opt: Option<String> = Option::deserialize(deserializer)?;
        match opt {
            Some(hex_str) => {
                let bytes = hex::decode(hex_str).map_err(serde::de::Error::custom)?;
                let key = P256VerifyingKey::from_sec1_bytes(&bytes)
                    .map_err(serde::de::Error::custom)?;
                Ok(Some(key))
            }
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ed25519_key_generation() {
        let keypair = KeyPair::generate();
        let public_key = keypair.public_key();
        assert_eq!(keypair.algorithm(), SignatureAlgorithm::Ed25519);
        assert_eq!(public_key.to_bytes().len(), 32);
    }

    #[test]
    fn test_p256_key_generation() {
        let keypair = KeyPair::generate_with_algorithm(SignatureAlgorithm::EcdsaP256);
        let public_key = keypair.public_key();
        assert_eq!(keypair.algorithm(), SignatureAlgorithm::EcdsaP256);
        assert_eq!(public_key.algorithm(), SignatureAlgorithm::EcdsaP256);
    }

    #[test]
    fn test_ed25519_sign_and_verify() {
        let keypair = KeyPair::generate();
        let message = b"test message";
        let signature = keypair.sign(message);
        let public_key = keypair.public_key();

        assert_eq!(signature.algorithm(), SignatureAlgorithm::Ed25519);
        assert!(public_key.verify(message, &signature).is_ok());
    }

    #[test]
    fn test_p256_sign_and_verify() {
        let keypair = KeyPair::generate_with_algorithm(SignatureAlgorithm::EcdsaP256);
        let message = b"test message";
        let signature = keypair.sign(message);
        let public_key = keypair.public_key();

        assert_eq!(signature.algorithm(), SignatureAlgorithm::EcdsaP256);
        assert!(public_key.verify(message, &signature).is_ok());
    }

    #[test]
    fn test_ed25519_verify_wrong_message() {
        let keypair = KeyPair::generate();
        let signature = keypair.sign(b"test message");
        let public_key = keypair.public_key();

        assert!(public_key.verify(b"wrong message", &signature).is_err());
    }

    #[test]
    fn test_p256_verify_wrong_message() {
        let keypair = KeyPair::generate_with_algorithm(SignatureAlgorithm::EcdsaP256);
        let signature = keypair.sign(b"test message");
        let public_key = keypair.public_key();

        assert!(public_key.verify(b"wrong message", &signature).is_err());
    }

    #[test]
    fn test_algorithm_mismatch() {
        let ed25519_keypair = KeyPair::generate();
        let p256_keypair = KeyPair::generate_with_algorithm(SignatureAlgorithm::EcdsaP256);

        let message = b"test message";
        let ed25519_signature = ed25519_keypair.sign(message);
        let p256_public_key = p256_keypair.public_key();

        // Should fail because algorithms don't match
        assert!(p256_public_key.verify(message, &ed25519_signature).is_err());
    }

    #[test]
    fn test_ed25519_public_key_serialization() {
        let keypair = KeyPair::generate();
        let public_key = keypair.public_key();
        let hex = public_key.to_hex();
        let restored = PublicKey::from_hex(&hex).unwrap();
        assert_eq!(public_key, restored);
    }

    #[test]
    fn test_p256_public_key_serialization() {
        let keypair = KeyPair::generate_with_algorithm(SignatureAlgorithm::EcdsaP256);
        let public_key = keypair.public_key();
        let hex = public_key.to_hex();
        let restored = PublicKey::from_hex_with_algorithm(&hex, SignatureAlgorithm::EcdsaP256).unwrap();
        assert_eq!(public_key, restored);
    }

    #[test]
    fn test_json_serialization() {
        let keypair = KeyPair::generate_with_algorithm(SignatureAlgorithm::EcdsaP256);
        let public_key = keypair.public_key();
        let message = b"test message";
        let signature = keypair.sign(message);

        // Serialize to JSON
        let public_key_json = serde_json::to_string(&public_key).unwrap();
        let signature_json = serde_json::to_string(&signature).unwrap();

        // Deserialize from JSON
        let restored_public_key: PublicKey = serde_json::from_str(&public_key_json).unwrap();
        let restored_signature: Signature = serde_json::from_str(&signature_json).unwrap();

        // Verify still works
        assert!(restored_public_key.verify(message, &restored_signature).is_ok());
    }
}
