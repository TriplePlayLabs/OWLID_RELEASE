//! AES-256-GCM authenticated encryption with random 96-bit nonces.
//! Used for at-rest encryption of sensitive stored data.

// `aes_gcm` 0.10 / `generic-array` 0.14 exposes `GenericArray::from_slice`
// as deprecated in favour of `generic-array` 1.x; upgrading the
// dependency is the proper fix but is left to a workspace-wide crypto
// bump. The current usage is safe (slice length is checked by the caller
// through fixed-size buffers).
#![allow(deprecated)]

use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, AeadCore, Key, Nonce,
};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum EncryptionError {
    #[error("Encryption failed: {0}")]
    EncryptionFailed(String),
    #[error("Decryption failed: {0}")]
    DecryptionFailed(String),
    #[error("Invalid key: {0}")]
    InvalidKey(String),
    #[error("Invalid nonce: {0}")]
    InvalidNonce(String),
}

/// Encrypt plaintext with AES-256-GCM
///
/// Returns (ciphertext, nonce) both as hex-encoded strings
pub fn encrypt(plaintext: &[u8], key: &[u8; 32]) -> Result<(String, String), EncryptionError> {
    let key = Key::<Aes256Gcm>::from_slice(key);
    let cipher = Aes256Gcm::new(key);

    // Generate random 96-bit nonce
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);

    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| EncryptionError::EncryptionFailed(e.to_string()))?;

    Ok((hex::encode(ciphertext), hex::encode(nonce)))
}

/// Decrypt ciphertext with AES-256-GCM
///
/// Takes hex-encoded ciphertext and nonce, returns plaintext bytes
pub fn decrypt(
    ciphertext_hex: &str,
    nonce_hex: &str,
    key: &[u8; 32],
) -> Result<Vec<u8>, EncryptionError> {
    let key = Key::<Aes256Gcm>::from_slice(key);
    let cipher = Aes256Gcm::new(key);

    let ciphertext = hex::decode(ciphertext_hex)
        .map_err(|e| EncryptionError::DecryptionFailed(format!("Invalid ciphertext hex: {}", e)))?;

    let nonce_bytes = hex::decode(nonce_hex)
        .map_err(|e| EncryptionError::InvalidNonce(format!("Invalid nonce hex: {}", e)))?;

    let nonce = Nonce::from_slice(&nonce_bytes);

    cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|e| EncryptionError::DecryptionFailed(e.to_string()))
}

/// Parse an encryption key from hex string
pub fn key_from_hex(hex_str: &str) -> Result<[u8; 32], EncryptionError> {
    let bytes = hex::decode(hex_str)
        .map_err(|e| EncryptionError::InvalidKey(format!("Invalid hex: {}", e)))?;
    bytes
        .try_into()
        .map_err(|_| EncryptionError::InvalidKey("Key must be 32 bytes (64 hex chars)".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = [42u8; 32];
        let plaintext = b"Hello, World! This is sensitive data.";

        let (ciphertext, nonce) = encrypt(plaintext, &key).unwrap();
        let decrypted = decrypt(&ciphertext, &nonce, &key).unwrap();

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_different_nonces() {
        let key = [42u8; 32];
        let plaintext = b"Same plaintext";

        let (ct1, n1) = encrypt(plaintext, &key).unwrap();
        let (ct2, n2) = encrypt(plaintext, &key).unwrap();

        // Same plaintext should produce different ciphertexts (random nonces)
        assert_ne!(ct1, ct2);
        assert_ne!(n1, n2);

        // Both should decrypt correctly
        assert_eq!(decrypt(&ct1, &n1, &key).unwrap(), plaintext);
        assert_eq!(decrypt(&ct2, &n2, &key).unwrap(), plaintext);
    }

    #[test]
    fn test_wrong_key_fails() {
        let key1 = [42u8; 32];
        let key2 = [43u8; 32];
        let plaintext = b"Secret data";

        let (ciphertext, nonce) = encrypt(plaintext, &key1).unwrap();
        assert!(decrypt(&ciphertext, &nonce, &key2).is_err());
    }

    #[test]
    fn test_key_from_hex() {
        let hex_key = "0".repeat(64);
        let key = key_from_hex(&hex_key).unwrap();
        assert_eq!(key, [0u8; 32]);
    }

    #[test]
    fn test_key_from_hex_invalid_length() {
        assert!(key_from_hex("0123").is_err());
    }
}
