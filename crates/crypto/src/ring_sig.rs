//! Schnorr-based ring signatures over Curve25519.
//!
//! Lets a signer prove membership in a group without revealing which
//! member they are (Abe-Ohkubo-Suzuki / AOS construction).

use curve25519_dalek::{
    constants::ED25519_BASEPOINT_TABLE,
    edwards::EdwardsPoint,
    scalar::Scalar,
};
use rand::RngCore;
use sha2::{Digest, Sha512};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum RingSignatureError {
    #[error("Ring must contain at least 2 members")]
    RingTooSmall,
    #[error("Signer not found in ring")]
    SignerNotInRing,
    #[error("Invalid signature")]
    InvalidSignature,
    #[error("Invalid public key")]
    InvalidPublicKey,
}

/// A ring signature proving membership in a set of public keys
#[derive(Debug, Clone)]
pub struct RingSignature {
    /// Challenge values (one per ring member)
    pub challenges: Vec<[u8; 32]>,
    /// Response values (one per ring member)
    pub responses: Vec<[u8; 32]>,
    /// Key image for linkability detection
    pub key_image: [u8; 32],
}

/// Hash function for ring signature construction
fn ring_hash(message: &[u8], point: &EdwardsPoint) -> Scalar {
    let mut hasher = Sha512::new();
    hasher.update(b"RingSig");
    hasher.update(message);
    hasher.update(point.compress().as_bytes());
    Scalar::from_hash(hasher)
}

/// Derive a Curve25519 scalar from an Ed25519 seed using the standard
/// Ed25519 key derivation: SHA-512(seed) → clamp lower 32 bytes.
fn ed25519_seed_to_scalar(seed: &[u8; 32]) -> Scalar {
    let hash = Sha512::digest(seed);
    let mut scalar_bytes = [0u8; 32];
    scalar_bytes.copy_from_slice(&hash[..32]);
    let clamped = curve25519_dalek::scalar::clamp_integer(scalar_bytes);
    Scalar::from_bytes_mod_order(clamped)
}

impl RingSignature {
    /// Core signing logic using a pre-computed scalar.
    fn sign_with_scalar(
        message: &[u8],
        secret: Scalar,
        ring: &[[u8; 32]],
    ) -> Result<Self, RingSignatureError> {
        if ring.len() < 2 {
            return Err(RingSignatureError::RingTooSmall);
        }

        let public_key = (&secret * ED25519_BASEPOINT_TABLE).compress();

        // Find signer's index in ring
        let signer_idx = ring
            .iter()
            .position(|pk| pk == public_key.as_bytes())
            .ok_or(RingSignatureError::SignerNotInRing)?;

        let n = ring.len();
        let mut challenges = vec![[0u8; 32]; n];
        let mut responses = vec![[0u8; 32]; n];

        // Generate random commitment
        let mut alpha_bytes = [0u8; 64];
        rand::rngs::OsRng.fill_bytes(&mut alpha_bytes);
        let alpha = Scalar::from_bytes_mod_order_wide(&alpha_bytes);

        // Compute commitment point
        let commitment = &alpha * ED25519_BASEPOINT_TABLE;

        // Compute key image
        let key_image = (&secret * &hash_to_point(public_key.as_bytes())).compress();

        // Start from signer_idx + 1 and go around the ring
        let next_idx = (signer_idx + 1) % n;
        let c_next = ring_hash(message, &commitment);
        challenges[next_idx] = c_next.to_bytes();

        // Fill in fake responses for non-signer positions
        let mut current_idx = next_idx;
        for _ in 0..n - 1 {
            // Generate random response
            let mut rand_bytes = [0u8; 64];
            rand::rngs::OsRng.fill_bytes(&mut rand_bytes);
            let s = Scalar::from_bytes_mod_order_wide(&rand_bytes);
            responses[current_idx] = s.to_bytes();

            let c = Scalar::from_bytes_mod_order(challenges[current_idx]);

            // Decompress the public key
            let pk_point = curve25519_dalek::edwards::CompressedEdwardsY(ring[current_idx])
                .decompress()
                .ok_or(RingSignatureError::InvalidPublicKey)?;

            // Compute next challenge
            let point = &s * ED25519_BASEPOINT_TABLE + c * pk_point;
            let next = (current_idx + 1) % n;
            challenges[next] = ring_hash(message, &point).to_bytes();
            current_idx = next;
        }

        // Close the ring: compute signer's response
        let c_signer = Scalar::from_bytes_mod_order(challenges[signer_idx]);
        let s_signer = alpha - c_signer * secret;
        responses[signer_idx] = s_signer.to_bytes();

        Ok(RingSignature {
            challenges,
            responses,
            key_image: key_image.to_bytes(),
        })
    }

    /// Create a ring signature using a raw 32-byte scalar as the private key.
    ///
    /// # Arguments
    /// * `message` - The message to sign
    /// * `private_key` - The signer's 32-byte private key (interpreted as a raw scalar)
    /// * `ring` - The set of public keys (compressed Edwards points)
    ///
    /// The signer's public key must be in the ring.
    /// Note: For Ed25519 keypairs (e.g. from `KeyPair`), use `sign_ed25519()` instead.
    pub fn sign(
        message: &[u8],
        private_key: &[u8; 32],
        ring: &[[u8; 32]],
    ) -> Result<Self, RingSignatureError> {
        let secret = Scalar::from_bytes_mod_order(*private_key);
        Self::sign_with_scalar(message, secret, ring)
    }

    /// Create a ring signature using an Ed25519 seed (first 32 bytes of `KeyPair::to_bytes()`).
    ///
    /// This properly derives the Curve25519 scalar via SHA-512 + clamping,
    /// matching the public key that Ed25519 produces. Use this when the signer's
    /// key comes from an `ed25519_dalek::SigningKey` or `owl_crypto::KeyPair`.
    ///
    /// # Arguments
    /// * `message` - The message to sign
    /// * `ed25519_seed` - The 32-byte Ed25519 seed
    /// * `ring` - The set of public keys (compressed Edwards points)
    pub fn sign_ed25519(
        message: &[u8],
        ed25519_seed: &[u8; 32],
        ring: &[[u8; 32]],
    ) -> Result<Self, RingSignatureError> {
        let secret = ed25519_seed_to_scalar(ed25519_seed);
        Self::sign_with_scalar(message, secret, ring)
    }

    /// Verify a ring signature
    ///
    /// # Arguments
    /// * `message` - The message that was signed
    /// * `ring` - The set of public keys
    pub fn verify(&self, message: &[u8], ring: &[[u8; 32]]) -> bool {
        if ring.len() < 2 || ring.len() != self.challenges.len() || ring.len() != self.responses.len()
        {
            return false;
        }

        let n = ring.len();

        // Verify the ring closes: each challenge must chain to the next
        for i in 0..n {
            let c = Scalar::from_bytes_mod_order(self.challenges[i]);
            let s = Scalar::from_bytes_mod_order(self.responses[i]);

            let pk_point = match curve25519_dalek::edwards::CompressedEdwardsY(ring[i]).decompress()
            {
                Some(p) => p,
                None => return false,
            };

            let point = &s * ED25519_BASEPOINT_TABLE + c * pk_point;
            let expected_next = ring_hash(message, &point).to_bytes();

            let next_idx = (i + 1) % n;
            if expected_next != self.challenges[next_idx] {
                return false;
            }
        }

        true
    }
}

/// Hash a byte slice to a point on the curve
fn hash_to_point(data: &[u8]) -> EdwardsPoint {
    let mut hasher = Sha512::new();
    hasher.update(b"HashToPoint");
    hasher.update(data);
    let hash = hasher.finalize();
    let mut wide = [0u8; 64];
    wide.copy_from_slice(&hash);
    let scalar = Scalar::from_bytes_mod_order_wide(&wide);
    &scalar * ED25519_BASEPOINT_TABLE
}

#[cfg(test)]
mod tests {
    use super::*;

    fn generate_keypair() -> ([u8; 32], [u8; 32]) {
        let mut private = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut private);
        let secret = Scalar::from_bytes_mod_order(private);
        let public = (&secret * ED25519_BASEPOINT_TABLE).compress();
        (private, *public.as_bytes())
    }

    #[test]
    fn test_ring_signature_2_members() {
        let (sk1, pk1) = generate_keypair();
        let (_, pk2) = generate_keypair();

        let ring = vec![pk1, pk2];
        let message = b"test message";

        let sig = RingSignature::sign(message, &sk1, &ring).unwrap();
        assert!(sig.verify(message, &ring));
    }

    #[test]
    fn test_ring_signature_5_members() {
        let (sk, pk) = generate_keypair();
        let mut ring = vec![pk];
        for _ in 0..4 {
            let (_, extra_pk) = generate_keypair();
            ring.push(extra_pk);
        }

        let message = b"ring of five";
        let sig = RingSignature::sign(message, &sk, &ring).unwrap();
        assert!(sig.verify(message, &ring));
    }

    #[test]
    fn test_ring_signature_10_members() {
        let (sk, pk) = generate_keypair();
        let mut ring = vec![pk];
        for _ in 0..9 {
            let (_, extra_pk) = generate_keypair();
            ring.push(extra_pk);
        }

        let message = b"ring of ten";
        let sig = RingSignature::sign(message, &sk, &ring).unwrap();
        assert!(sig.verify(message, &ring));
    }

    #[test]
    fn test_wrong_message_fails() {
        let (sk, pk) = generate_keypair();
        let (_, pk2) = generate_keypair();
        let ring = vec![pk, pk2];

        let sig = RingSignature::sign(b"correct", &sk, &ring).unwrap();
        assert!(!sig.verify(b"wrong", &ring));
    }

    #[test]
    fn test_ring_too_small() {
        let (sk, pk) = generate_keypair();
        let ring = vec![pk];

        let result = RingSignature::sign(b"msg", &sk, &ring);
        assert!(matches!(result, Err(RingSignatureError::RingTooSmall)));
    }

    #[test]
    fn test_signer_not_in_ring() {
        let (sk, _) = generate_keypair();
        let (_, pk2) = generate_keypair();
        let (_, pk3) = generate_keypair();
        let ring = vec![pk2, pk3];

        let result = RingSignature::sign(b"msg", &sk, &ring);
        assert!(matches!(result, Err(RingSignatureError::SignerNotInRing)));
    }

    #[test]
    fn test_ring_signature_with_ed25519_keypair() {
        use ed25519_dalek::SigningKey;

        // Generate Ed25519 keypairs the standard way
        let signing_key = SigningKey::generate(&mut rand::rngs::OsRng);
        let seed = signing_key.to_bytes();
        let verifying_key = signing_key.verifying_key();
        let pk1: [u8; 32] = verifying_key.to_bytes();

        // Generate decoy keys using the same Ed25519 approach
        let decoy1 = SigningKey::generate(&mut rand::rngs::OsRng);
        let pk2: [u8; 32] = decoy1.verifying_key().to_bytes();
        let decoy2 = SigningKey::generate(&mut rand::rngs::OsRng);
        let pk3: [u8; 32] = decoy2.verifying_key().to_bytes();

        let ring = vec![pk1, pk2, pk3];
        let message = b"ed25519 interop test";

        // sign_ed25519 should work with the Ed25519 seed
        let sig = RingSignature::sign_ed25519(message, &seed, &ring).unwrap();
        assert!(sig.verify(message, &ring));

        // sign() with the raw seed should fail (scalar mismatch → SignerNotInRing)
        let result = RingSignature::sign(message, &seed, &ring);
        assert!(
            matches!(result, Err(RingSignatureError::SignerNotInRing)),
            "Raw sign() with Ed25519 seed should fail because the derived public key differs"
        );
    }
}
