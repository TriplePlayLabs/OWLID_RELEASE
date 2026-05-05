use crate::document::ProofDocument;
use crate::error::ProofSystemError;
use crate::revocation::RevocationChecker;
use chrono::Utc;
use owl_crypto::{CoseKey, KeyPair, MerkleProof, PublicKey, Signature, WebAuthnSignature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// Verifier's proof request — specifies WHAT to prove, system decides HOW
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProofRequest {
    /// Attributes to reveal as plaintext (Merkle selective disclosure)
    pub disclose: Vec<String>,
    /// Predicate proofs — ZK proofs without revealing values
    pub predicates: Vec<PredicateRequest>,
    /// Trusted issuer public keys (hex)
    pub trusted_issuers: Vec<String>,
    /// Random challenge for replay prevention
    pub challenge: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredicateRequest {
    /// Credential attribute name (e.g., "dateOfBirth", "nationality")
    pub attribute: String,
    /// Predicate operator
    pub op: PredicateOp,
    /// Threshold/target value
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum PredicateOp {
    /// e.g., age >= 18, kycLevel >= 2
    GreaterOrEqual,
    /// e.g., nationality in dataset "eu"
    InSet,
}

/// Owner signature type - supports standard Ed25519, WebAuthn P-256, and ring signatures
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum OwnerSignature {
    /// Standard Ed25519 signature
    Standard {
        #[serde(flatten)]
        signature: Signature,
    },
    /// WebAuthn P-256 signature from secure enclave
    WebAuthn {
        /// Base64-encoded authenticator data
        #[serde(rename = "authenticatorData")]
        authenticator_data: String,
        /// Base64-encoded client data JSON
        #[serde(rename = "clientDataJSON")]
        client_data_json: String,
        /// Base64-encoded signature
        signature: String,
        /// Base64-encoded COSE public key
        #[serde(rename = "credentialPublicKey")]
        credential_public_key: String,
    },
    /// T-022: Ring signature proving membership in a set of public keys
    /// without revealing which specific key signed
    RingSig {
        /// Hex-encoded ring member challenges
        challenges: Vec<String>,
        /// Hex-encoded ring member responses
        responses: Vec<String>,
        /// Hex-encoded key image
        key_image: String,
        /// Hex-encoded ring member public keys (32 bytes each)
        ring: Vec<String>,
    },
}

/// Prepared token ready for signing
/// Contains the payload and challenge for WebAuthn signing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparedToken {
    /// The token payload
    pub payload: TokenPayload,
    /// Serialized payload JSON (for signing)
    pub payload_json: String,
    /// Challenge for WebAuthn: base64url(SHA256(payload_json))
    pub challenge: String,
}

impl PreparedToken {
    /// Get the challenge for WebAuthn signing
    pub fn challenge(&self) -> &str {
        &self.challenge
    }

    /// Get the payload JSON
    pub fn payload_json(&self) -> &str {
        &self.payload_json
    }

    /// Get the payload
    pub fn payload(&self) -> &TokenPayload {
        &self.payload
    }
}

/// Token payload before signing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenPayload {
    /// Challenge from the verifier
    pub challenge: String,
    /// Root hash of the document
    pub root_hash: String,
    /// Signature of the document by issuer
    pub signature: Signature,
    /// Proof of inclusion for disclosed attributes
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proof_of_inclusion: Option<MerkleProof>,
    /// The attributes being disclosed (BTreeMap for deterministic JSON serialization)
    pub subjects: BTreeMap<String, serde_json::Value>,
    /// Time to live in seconds
    pub ttl: i64,
    /// When the token becomes active (epoch seconds)
    pub activation_time: i64,
    /// Optional additional data
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    /// Per-document salt for Merkle leaf hash recomputation (T-004)
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub salt: Option<String>,
    /// Signers: issuer and owner public key hex strings (T-011)
    #[serde(default)]
    pub signers: Vec<String>,
    /// Minimum number of owner signatures required (T-007, defaults to 1)
    #[serde(default = "default_threshold")]
    pub signer_threshold: u32,
    /// ZK proofs for privacy-preserving predicates (T-016)
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub zk_proofs: Vec<serde_json::Value>,
    /// Leaf hashes of attributes committed in the Merkle proof but not
    /// disclosed. Maps attribute name → leaf hash (hex).
    /// Binds ZK proofs to the issuer-signed credential.
    #[serde(skip_serializing_if = "BTreeMap::is_empty", default)]
    pub committed_attributes: BTreeMap<String, String>,
    /// Predicate ids this credential is permitted to prove. Surfaced from
    /// `ProofDocument` so `Token::verify` can reject proofs whose predicate
    /// id is not on the issuer-signed allowlist.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub available_predicates: Vec<String>,
}

fn default_threshold() -> u32 {
    1
}

/// Complete token with owner signature(s)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Token {
    payload: TokenPayload,
    /// Signature of the payload by the token owner (standard Ed25519 or WebAuthn P-256)
    /// Kept for backward compatibility with single-owner tokens
    #[serde(skip_serializing_if = "Option::is_none")]
    owner_signature: Option<OwnerSignature>,
    /// Multiple owner signatures for multisig support (T-007)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    owner_signatures: Vec<OwnerSignature>,
    /// HMAC-SHA256 of the token payload for integrity verification (T-012)
    #[serde(skip_serializing_if = "Option::is_none")]
    hmac: Option<String>,
}

impl Token {
    /// Compute HMAC-SHA256 of the token payload (T-012)
    pub fn compute_hmac(payload: &TokenPayload, key: &[u8]) -> String {
        use hmac::{Hmac, Mac};
        type HmacSha256 = Hmac<Sha256>;
        let payload_json = serde_json::to_string(payload).unwrap_or_default();
        let mut mac =
            HmacSha256::new_from_slice(key).expect("HMAC can take key of any size");
        mac.update(payload_json.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    /// Set HMAC on this token
    pub fn set_hmac(&mut self, key: &[u8]) {
        self.hmac = Some(Self::compute_hmac(&self.payload, key));
    }

    /// Verify HMAC if present
    pub fn verify_hmac(&self, key: &[u8]) -> Result<(), ProofSystemError> {
        if let Some(ref hmac_value) = self.hmac {
            let expected = Self::compute_hmac(&self.payload, key);
            if hmac_value != &expected {
                return Err(ProofSystemError::InvalidProof(
                    "HMAC verification failed".to_string(),
                ));
            }
        }
        Ok(())
    }

    /// Phase 2a: Finalize token with standard Ed25519 signature
    pub fn finalize_standard(
        prepared: PreparedToken,
        owner_keypair: &KeyPair,
    ) -> Result<Self, ProofSystemError> {
        let signature = owner_keypair.sign(prepared.payload_json.as_bytes());
        let owner_sig = OwnerSignature::Standard { signature };

        Ok(Token {
            payload: prepared.payload,
            owner_signature: Some(owner_sig.clone()),
            owner_signatures: vec![owner_sig],
            hmac: None,
        })
    }

    /// Phase 2b: Finalize token with WebAuthn signature
    ///
    /// The WebAuthn signature must be created with the challenge from PreparedToken.
    /// This binds the hardware-backed signature to the specific token payload.
    pub fn finalize_webauthn(
        prepared: PreparedToken,
        authenticator_data: String,
        client_data_json: String,
        signature: String,
        credential_public_key: String,
    ) -> Result<Self, ProofSystemError> {
        // Verify the WebAuthn signature is valid before creating the token
        let webauthn_sig = WebAuthnSignature::new(
            authenticator_data.clone(),
            client_data_json.clone(),
            signature.clone(),
        );

        // Parse the COSE public key and verify signature
        let cose_key = CoseKey::from_base64(&credential_public_key)?;
        let webauthn_pubkey = cose_key.to_public_key()?;
        webauthn_sig.verify_payload_bound(&webauthn_pubkey, prepared.payload_json.as_bytes())?;

        let owner_sig = OwnerSignature::WebAuthn {
            authenticator_data,
            client_data_json,
            signature,
            credential_public_key,
        };

        Ok(Token {
            payload: prepared.payload,
            owner_signature: Some(owner_sig.clone()),
            owner_signatures: vec![owner_sig],
            hmac: None,
        })
    }

    /// Phase 2c: Finalize token with a ring signature (T-022)
    ///
    /// Creates an anonymous proof that the signer is one of the ring members
    /// without revealing which specific member signed.
    ///
    /// `private_key` is the 32-byte Ed25519 seed (first 32 bytes of `KeyPair::to_bytes()`).
    /// The scalar is derived via the standard Ed25519 derivation (SHA-512 + clamping).
    pub fn finalize_ring_sig(
        prepared: PreparedToken,
        private_key: &[u8; 32],
        ring: &[[u8; 32]],
    ) -> Result<Self, ProofSystemError> {
        use owl_crypto::RingSignature;

        let ring_sig =
            RingSignature::sign_ed25519(prepared.payload_json.as_bytes(), private_key, ring)
                .map_err(|e| {
                    ProofSystemError::InvalidProof(format!("Ring signature failed: {}", e))
                })?;

        let owner_sig = OwnerSignature::RingSig {
            challenges: ring_sig.challenges.iter().map(hex::encode).collect(),
            responses: ring_sig.responses.iter().map(hex::encode).collect(),
            key_image: hex::encode(ring_sig.key_image),
            ring: ring.iter().map(hex::encode).collect(),
        };

        Ok(Token {
            payload: prepared.payload,
            owner_signature: Some(owner_sig.clone()),
            owner_signatures: vec![owner_sig],
            hmac: None,
        })
    }

    /// Build the token payload with automatic ZK proofs + Merkle disclosure.
    fn build_payload(
        proof_doc: &mut ProofDocument,
        request: &ProofRequest,
        ttl_seconds: i64,
    ) -> Result<TokenPayload, ProofSystemError> {
        // 1. Validate all disclose and predicate attributes exist
        for attr in &request.disclose {
            if !proof_doc.attributes().contains_key(attr) {
                return Err(ProofSystemError::MissingAttribute(attr.clone()));
            }
        }
        for pred in &request.predicates {
            if !proof_doc.attributes().contains_key(&pred.attribute) {
                return Err(ProofSystemError::MissingAttribute(pred.attribute.clone()));
            }
        }

        // 2. Build disclosure keys: issuerKey + ownerKey + disclose items
        let mut disclosure_keys = Vec::new();
        disclosure_keys.push("issuerKey".to_string());
        if proof_doc.attributes().contains_key("ownerKeys") {
            disclosure_keys.push("ownerKeys".to_string());
        } else {
            disclosure_keys.push("ownerKey".to_string());
        }
        for attr in &request.disclose {
            if !disclosure_keys.contains(attr) {
                disclosure_keys.push(attr.clone());
            }
        }

        // 3. Build committed keys: predicate attributes NOT already in disclosure keys
        let mut committed_keys = Vec::new();
        for pred in &request.predicates {
            if !disclosure_keys.contains(&pred.attribute) && !committed_keys.contains(&pred.attribute) {
                committed_keys.push(pred.attribute.clone());
            }
        }

        // 4. Compute Merkle proof for ALL keys (disclosure + committed)
        let mut all_proof_keys = disclosure_keys.clone();
        for k in &committed_keys {
            all_proof_keys.push(k.clone());
        }
        let proof_of_inclusion = proof_doc.generate_proof(&all_proof_keys)?;

        // 5. Build subjects from disclosure keys only
        let mut subjects = BTreeMap::new();
        for key in &disclosure_keys {
            if let Some(value) = proof_doc.get_attribute(key) {
                subjects.insert(key.clone(), value.clone());
            }
        }

        // 6. For each committed key: compute leaf hash → add to committed_attributes
        let mut committed_attributes = BTreeMap::new();
        for key in &committed_keys {
            let leaf_hash = proof_doc
                .leaf_hash_hex(key)
                .ok_or_else(|| ProofSystemError::InvalidProof(format!("No leaf hash for '{}'", key)))?;
            committed_attributes.insert(key.clone(), leaf_hash);
        }

        // 7. For each predicate: extract value → generate_predicate_proof
        let mut zk_proofs = Vec::new();
        for pred in &request.predicates {
            let attr_value = proof_doc
                .get_attribute(&pred.attribute)
                .ok_or_else(|| ProofSystemError::MissingAttribute(pred.attribute.clone()))?
                .clone();
            let leaf_hash = proof_doc
                .leaf_hash_hex(&pred.attribute)
                .ok_or_else(|| ProofSystemError::InvalidProof(format!("No leaf hash for '{}'", pred.attribute)))?;
            let proof = crate::zk::generate_predicate_proof(pred, &attr_value, &leaf_hash)?;
            zk_proofs.push(crate::zk::zk_proof_to_value(&proof));
        }

        // Build signers list
        let mut signers = Vec::new();
        if let Some(ik) = subjects.get("issuerKey").and_then(|v| v.as_str()) {
            signers.push(ik.to_string());
        }
        if let Some(ok) = subjects.get("ownerKey").and_then(|v| v.as_str()) {
            signers.push(ok.to_string());
        }

        Ok(TokenPayload {
            challenge: request.challenge.clone(),
            root_hash: proof_doc.root_hash().to_string(),
            signature: proof_doc.signature().clone(),
            proof_of_inclusion: Some(proof_of_inclusion),
            subjects,
            ttl: ttl_seconds,
            activation_time: Utc::now().timestamp(),
            data: None,
            salt: proof_doc.salt().map(|s| s.to_string()),
            signers,
            signer_threshold: 1,
            zk_proofs,
            committed_attributes,
            available_predicates: proof_doc.available_predicates().to_vec(),
        })
    }

    /// Generate a proof token with automatic ZK proofs + Merkle disclosure.
    /// Signs with Ed25519.
    pub fn generate(
        proof_doc: &mut ProofDocument,
        request: &ProofRequest,
        owner_keypair: &KeyPair,
        ttl_seconds: i64,
    ) -> Result<Self, ProofSystemError> {
        let payload = Self::build_payload(proof_doc, request, ttl_seconds)?;
        let payload_json = serde_json::to_string(&payload)?;
        let signature = owner_keypair.sign(payload_json.as_bytes());
        let owner_sig = OwnerSignature::Standard { signature };

        Ok(Token {
            payload,
            owner_signature: Some(owner_sig.clone()),
            owner_signatures: vec![owner_sig],
            hmac: None,
        })
    }

    /// Prepare a token for WebAuthn/RingSig signing.
    ///
    /// Creates the token payload with ZK proofs + Merkle disclosure
    /// and computes the challenge (base64url(SHA256(payload_json))).
    pub fn prepare(
        proof_doc: &mut ProofDocument,
        request: &ProofRequest,
        ttl_seconds: i64,
    ) -> Result<PreparedToken, ProofSystemError> {
        let payload = Self::build_payload(proof_doc, request, ttl_seconds)?;
        let payload_json = serde_json::to_string(&payload)?;

        let mut hasher = Sha256::new();
        hasher.update(payload_json.as_bytes());
        let hash = hasher.finalize();
        let challenge = base64url_encode(&hash);

        Ok(PreparedToken {
            payload,
            payload_json,
            challenge,
        })
    }

    /// Verify the token with all security checks including revocation.
    ///
    /// `expected_origins` is the verifier's allowlist for the WebAuthn
    /// `clientDataJSON.origin` field (the host serving the SPA — e.g.
    /// `https://owlid-app.sashoush.dev`). When non-empty, WebAuthn
    /// owner-signature verification fails closed if the signed origin is
    /// not on the list. Pass `&[]` only in tests / dev environments where
    /// origin-binding is not yet wired.
    pub fn verify(
        &self,
        trusted_issuers: &[PublicKey],
        challenge: &str,
        revocation_checker: &dyn RevocationChecker,
        expected_origins: &[String],
    ) -> Result<(), ProofSystemError> {
        // 1. Verify challenge matches
        if self.payload.challenge != challenge {
            return Err(ProofSystemError::ChallengeMismatch);
        }

        // 2. Check token is active
        let now = Utc::now().timestamp();
        if now < self.payload.activation_time {
            return Err(ProofSystemError::TokenNotActive);
        }

        // 3. Check token not expired
        let expiry = self.payload.activation_time + self.payload.ttl;
        if now > expiry {
            return Err(ProofSystemError::TokenExpired);
        }

        // 4. Check revocation status
        if revocation_checker.is_revoked(&self.payload.root_hash) {
            return Err(ProofSystemError::CredentialRevoked(
                self.payload.root_hash.clone(),
            ));
        }

        // 5. Get issuer and owner keys from subjects
        let issuer_key_str = self
            .payload
            .subjects
            .get("issuerKey")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ProofSystemError::MissingAttribute("issuerKey".to_string()))?;

        // T-007: Support both single ownerKey and multiple ownerKeys
        let owner_keys: Vec<PublicKey> = if let Some(owner_keys_value) =
            self.payload.subjects.get("ownerKeys")
        {
            let keys_array = owner_keys_value
                .as_array()
                .ok_or_else(|| ProofSystemError::InvalidProof("ownerKeys must be an array".to_string()))?;
            let mut keys = Vec::new();
            for k in keys_array {
                let key_str = k
                    .as_str()
                    .ok_or_else(|| ProofSystemError::InvalidProof("ownerKeys entries must be strings".to_string()))?;
                keys.push(PublicKey::from_hex(key_str)?);
            }
            keys
        } else {
            let owner_key_str = self
                .payload
                .subjects
                .get("ownerKey")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ProofSystemError::MissingAttribute("ownerKey".to_string()))?;
            vec![PublicKey::from_hex(owner_key_str)?]
        };

        let issuer_key = PublicKey::from_hex(issuer_key_str)?;

        // 6. Verify issuer is trusted
        if !trusted_issuers.iter().any(|k| k == &issuer_key) {
            return Err(ProofSystemError::UntrustedIssuer(
                issuer_key_str.to_string(),
            ));
        }

        // 7. Verify document signature. The issuer signs canonical bytes
        //    that pin both the root hash and the available_predicates
        //    allowlist, so the allowlist cannot be widened post-issuance.
        let signing_input = crate::document::issuer_signing_input(
            &self.payload.root_hash,
            &self.payload.available_predicates,
        );
        issuer_key.verify(&signing_input, &self.payload.signature)?;

        // 8. Verify proof of inclusion
        if let Some(proof) = &self.payload.proof_of_inclusion {
            if proof.root_hash_hex() != self.payload.root_hash {
                return Err(ProofSystemError::InvalidProof(
                    "Root hash mismatch".to_string(),
                ));
            }

            let valid = if self.payload.committed_attributes.is_empty() {
                // Standard verification: all proof leaves must be in subjects
                proof.verify_with_salt(
                    &self.payload.subjects,
                    self.payload.salt.as_deref(),
                )
            } else {
                // Unified verification: some leaves are disclosed, some committed
                proof.verify_with_commitments(
                    &self.payload.subjects,
                    &self.payload.committed_attributes,
                    self.payload.salt.as_deref(),
                )
            };
            if !valid {
                return Err(ProofSystemError::InvalidProof(
                    "Proof verification failed".to_string(),
                ));
            }
        }

        // 9. Verify owner signature(s) on payload (T-007: multisig support)
        let payload_json = serde_json::to_string(&self.payload)?;

        // Collect all signatures (backward compat: check both owner_signature and owner_signatures)
        let all_signatures: Vec<&OwnerSignature> = if !self.owner_signatures.is_empty() {
            self.owner_signatures.iter().collect()
        } else if let Some(ref sig) = self.owner_signature {
            vec![sig]
        } else {
            return Err(ProofSystemError::InvalidProof(
                "No owner signature found".to_string(),
            ));
        };

        let threshold = self.payload.signer_threshold.max(1) as usize;

        // Track which owner keys have successfully verified (prevent duplicate sigs from same key)
        let mut verified_key_indices = std::collections::HashSet::new();

        for owner_sig in &all_signatures {
            match owner_sig {
                OwnerSignature::Standard { signature } => {
                    // Try to verify against each owner key
                    for (idx, owner_key) in owner_keys.iter().enumerate() {
                        if verified_key_indices.contains(&idx) {
                            continue;
                        }
                        if owner_key.verify(payload_json.as_bytes(), signature).is_ok() {
                            verified_key_indices.insert(idx);
                            break;
                        }
                    }
                }
                OwnerSignature::WebAuthn {
                    authenticator_data,
                    client_data_json,
                    signature,
                    credential_public_key,
                } => {
                    let cose_key = CoseKey::from_base64(credential_public_key)?;
                    let webauthn_pubkey = cose_key.to_public_key()?;

                    // Find matching owner key
                    for (idx, owner_key) in owner_keys.iter().enumerate() {
                        if verified_key_indices.contains(&idx) {
                            continue;
                        }
                        if &webauthn_pubkey == owner_key {
                            let webauthn_sig = WebAuthnSignature::new(
                                authenticator_data.clone(),
                                client_data_json.clone(),
                                signature.clone(),
                            );
                            let result = if expected_origins.is_empty() {
                                webauthn_sig.verify_payload_bound(
                                    &webauthn_pubkey,
                                    payload_json.as_bytes(),
                                )
                            } else {
                                webauthn_sig.verify_payload_bound_with_origin(
                                    &webauthn_pubkey,
                                    payload_json.as_bytes(),
                                    expected_origins,
                                )
                            };
                            if result.is_ok() {
                                verified_key_indices.insert(idx);
                                break;
                            }
                        }
                    }
                }
                OwnerSignature::RingSig {
                    challenges,
                    responses,
                    key_image,
                    ring,
                } => {
                    // T-022: Verify ring signature
                    // Reconstruct the RingSignature and verify it
                    use owl_crypto::ring_sig::RingSignature;

                    let ring_sig = RingSignature {
                        challenges: challenges
                            .iter()
                            .filter_map(|c| {
                                let bytes = hex::decode(c).ok()?;
                                <[u8; 32]>::try_from(bytes.as_slice()).ok()
                            })
                            .collect(),
                        responses: responses
                            .iter()
                            .filter_map(|r| {
                                let bytes = hex::decode(r).ok()?;
                                <[u8; 32]>::try_from(bytes.as_slice()).ok()
                            })
                            .collect(),
                        key_image: hex::decode(key_image)
                            .ok()
                            .and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok())
                            .unwrap_or([0u8; 32]),
                    };

                    let ring_keys: Vec<[u8; 32]> = ring
                        .iter()
                        .filter_map(|k| {
                            let bytes = hex::decode(k).ok()?;
                            <[u8; 32]>::try_from(bytes.as_slice()).ok()
                        })
                        .collect();

                    if ring_sig.verify(payload_json.as_bytes(), &ring_keys) {
                        // Ring signature is valid - the signer is one of the ring members
                        // Check if any ring member is an owner key
                        for (idx, owner_key) in owner_keys.iter().enumerate() {
                            if verified_key_indices.contains(&idx) {
                                continue;
                            }
                            let owner_bytes = owner_key.to_bytes();
                            if ring_keys.iter().any(|rk| rk.as_slice() == owner_bytes.as_slice()) {
                                verified_key_indices.insert(idx);
                                break;
                            }
                        }
                    }
                }
            }
        }

        if verified_key_indices.len() < threshold {
            return Err(ProofSystemError::InvalidProof(format!(
                "Insufficient valid signatures: {} of {} required",
                verified_key_indices.len(),
                threshold
            )));
        }

        // 10. Verify ZK proofs if present (T-016): each proof must claim a
        // registered predicate and pin to its canonical public input.
        if !self.payload.zk_proofs.is_empty() {
            crate::zk::verify_all_zk_proofs(&self.payload.zk_proofs)?;

            // 10a. Reject proofs whose predicate is not on the credential's
            // issuer-signed allowlist. If the credential pre-dates the
            // registry (`available_predicates` empty), the allowlist check
            // is skipped — Groth16 + pinned-input still apply.
            if !self.payload.available_predicates.is_empty() {
                for zk_value in &self.payload.zk_proofs {
                    let zk_proof = crate::zk::zk_proof_from_value(zk_value).map_err(|e| {
                        ProofSystemError::InvalidProof(format!(
                            "ZK proof deserialization failed: {}",
                            e
                        ))
                    })?;
                    let pred = crate::zk::resolve_proof_predicate(&zk_proof).ok_or_else(|| {
                        ProofSystemError::InvalidProof(
                            "ZK proof does not match any registered predicate".to_string(),
                        )
                    })?;
                    if !self
                        .payload
                        .available_predicates
                        .iter()
                        .any(|id| id == pred.id)
                    {
                        return Err(ProofSystemError::InvalidProof(format!(
                            "Predicate '{}' not on credential's available_predicates",
                            pred.id
                        )));
                    }
                }
            }

            // 10b. Verify ZK proof attribute bindings
            if let Some(proof) = &self.payload.proof_of_inclusion {
                let proof_leaf_hashes: std::collections::HashSet<String> = proof
                    .proof_leaves()
                    .iter()
                    .map(|l| hex::encode(l.hash()))
                    .collect();

                for zk_value in &self.payload.zk_proofs {
                    if let Ok(zk_proof) = crate::zk::zk_proof_from_value(zk_value) {
                        if let Some(ref attr_leaf_hash) = zk_proof.attribute_leaf_hash {
                            if !proof_leaf_hashes.contains(attr_leaf_hash) {
                                return Err(ProofSystemError::InvalidProof(
                                    format!(
                                        "ZK proof attribute binding failed: leaf hash {} not in Merkle proof",
                                        attr_leaf_hash
                                    ),
                                ));
                            }
                        }
                        // If attribute_leaf_hash is None (old unbound proofs), skip check
                    }
                }
            }
        }

        Ok(())
    }

    /// Get the payload
    pub fn payload(&self) -> &TokenPayload {
        &self.payload
    }

    /// Get disclosed subjects
    pub fn subjects(&self) -> &BTreeMap<String, serde_json::Value> {
        &self.payload.subjects
    }

    /// Get a specific subject value
    pub fn get_subject(&self, key: &str) -> Option<&serde_json::Value> {
        self.payload.subjects.get(key)
    }

    /// Get the ZK proofs attached to this token
    pub fn zk_proofs(&self) -> &[serde_json::Value] {
        &self.payload.zk_proofs
    }

    /// Get the owner signature (single, for backward compat)
    pub fn owner_signature(&self) -> Option<&OwnerSignature> {
        self.owner_signature.as_ref()
    }

    /// Get all owner signatures
    pub fn owner_signatures(&self) -> &[OwnerSignature] {
        &self.owner_signatures
    }

    /// Get the HMAC if set
    pub fn hmac(&self) -> Option<&str> {
        self.hmac.as_deref()
    }

    /// Construct a Token from its constituent parts (used by compact decode)
    pub fn from_parts(
        payload: TokenPayload,
        owner_signature: Option<OwnerSignature>,
        owner_signatures: Vec<OwnerSignature>,
        hmac: Option<String>,
    ) -> Self {
        Self {
            payload,
            owner_signature,
            owner_signatures,
            hmac,
        }
    }
}

/// Encode bytes as base64url (no padding)
fn base64url_encode(data: &[u8]) -> String {
    use base64::prelude::*;
    BASE64_STANDARD
        .encode(data)
        .replace('+', "-")
        .replace('/', "_")
        .trim_end_matches('=')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::Document;
    use serde_json::json;

    #[test]
    fn test_token_generation_and_verification() {
        use crate::revocation::RevocationRegistry;

        let issuer = KeyPair::generate();
        let owner = KeyPair::generate();

        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
        attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
        attrs.insert("name".to_string(), json!("John Doe"));
        attrs.insert("dateOfBirth".to_string(), json!("1994-06-15"));

        let doc = Document::new(attrs).unwrap();
        let mut proof_doc = doc.issue(&issuer);

        let request = ProofRequest {
            disclose: vec!["name".to_string()],
            predicates: vec![PredicateRequest {
                attribute: "dateOfBirth".to_string(),
                op: PredicateOp::GreaterOrEqual,
                value: serde_json::json!(18),
            }],
            trusted_issuers: vec![issuer.public_key().to_hex()],
            challenge: "random_challenge_12345".to_string(),
        };

        let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();

        let registry = RevocationRegistry::new();
        let trusted = vec![issuer.public_key()];
        assert!(token.verify(&trusted, "random_challenge_12345", &registry, &[]).is_ok());
    }

    #[test]
    fn test_token_verification_fails_wrong_challenge() {
        use crate::revocation::RevocationRegistry;

        let issuer = KeyPair::generate();
        let owner = KeyPair::generate();

        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
        attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
        attrs.insert("name".to_string(), json!("Test"));

        let doc = Document::new(attrs).unwrap();
        let mut proof_doc = doc.issue(&issuer);

        let request = ProofRequest {
            disclose: vec!["name".to_string()],
            predicates: vec![],
            trusted_issuers: vec![issuer.public_key().to_hex()],
            challenge: "challenge123".to_string(),
        };

        let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();
        let registry = RevocationRegistry::new();
        let trusted = vec![issuer.public_key()];

        assert!(token.verify(&trusted, "wrong_challenge", &registry, &[]).is_err());
    }

    #[test]
    fn test_token_verification_fails_untrusted_issuer() {
        use crate::revocation::RevocationRegistry;

        let issuer = KeyPair::generate();
        let other_issuer = KeyPair::generate();
        let owner = KeyPair::generate();

        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
        attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
        attrs.insert("name".to_string(), json!("Test"));

        let doc = Document::new(attrs).unwrap();
        let mut proof_doc = doc.issue(&issuer);

        let request = ProofRequest {
            disclose: vec!["name".to_string()],
            predicates: vec![],
            trusted_issuers: vec![issuer.public_key().to_hex()],
            challenge: "challenge123".to_string(),
        };

        let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();
        let registry = RevocationRegistry::new();

        let trusted = vec![other_issuer.public_key()];
        assert!(token.verify(&trusted, "challenge123", &registry, &[]).is_err());
    }

    #[test]
    fn test_token_verification_with_revocation() {
        use crate::revocation::RevocationRegistry;

        let issuer = KeyPair::generate();
        let owner = KeyPair::generate();

        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
        attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
        attrs.insert("name".to_string(), json!("Jane Doe"));

        let doc = Document::new(attrs).unwrap();
        let mut proof_doc = doc.issue(&issuer);
        let root_hash = proof_doc.root_hash().to_string();

        let request = ProofRequest {
            disclose: vec!["name".to_string()],
            predicates: vec![],
            trusted_issuers: vec![issuer.public_key().to_hex()],
            challenge: "challenge_with_revocation".to_string(),
        };

        let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();
        let trusted = vec![issuer.public_key()];
        let registry = RevocationRegistry::new();

        assert!(token.verify(&trusted, "challenge_with_revocation", &registry, &[]).is_ok());

        registry.revoke(
            root_hash.clone(),
            issuer.public_key().to_hex(),
            Some("Test revocation".to_string()),
        );

        let result = token.verify(&trusted, "challenge_with_revocation", &registry, &[]);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            ProofSystemError::CredentialRevoked(_)
        ));

        registry.reactivate(root_hash, issuer.public_key().to_hex());
        assert!(token.verify(&trusted, "challenge_with_revocation", &registry, &[]).is_ok());
    }

    #[test]
    fn test_token_rejects_predicate_not_on_credential_allowlist() {
        use crate::revocation::RevocationRegistry;

        let issuer = KeyPair::generate();
        let owner = KeyPair::generate();

        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
        attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
        // DOB old enough for 65+ to actually generate (proof gen would
        // otherwise fail before the allowlist check runs).
        attrs.insert("dateOfBirth".to_string(), json!("1950-01-01"));

        // Issue a credential that ONLY allows the 18+ predicate, not 65+.
        let doc = Document::new(attrs)
            .unwrap()
            .with_available_predicates(vec!["age:>=18".to_string()]);
        let mut proof_doc = doc.issue(&issuer);

        let request = ProofRequest {
            disclose: vec![],
            predicates: vec![PredicateRequest {
                attribute: "dateOfBirth".to_string(),
                op: PredicateOp::GreaterOrEqual,
                value: json!(65),
            }],
            trusted_issuers: vec![issuer.public_key().to_hex()],
            challenge: "allowlist-test".to_string(),
        };

        let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();

        let registry = RevocationRegistry::new();
        let trusted = vec![issuer.public_key()];
        let result = token.verify(&trusted, "allowlist-test", &registry, &[]);
        assert!(result.is_err(), "65+ proof should be rejected when only 18+ is on allowlist");
        let err = result.unwrap_err().to_string();
        assert!(err.contains("age:>=65"), "error should mention rejected predicate id: {}", err);
    }

    #[test]
    fn test_token_accepts_predicate_on_credential_allowlist() {
        use crate::revocation::RevocationRegistry;

        let issuer = KeyPair::generate();
        let owner = KeyPair::generate();

        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
        attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
        attrs.insert("dateOfBirth".to_string(), json!("1990-01-01"));

        let doc = Document::new(attrs)
            .unwrap()
            .with_available_predicates(vec!["age:>=18".to_string(), "age:>=21".to_string()]);
        let mut proof_doc = doc.issue(&issuer);

        let request = ProofRequest {
            disclose: vec![],
            predicates: vec![PredicateRequest {
                attribute: "dateOfBirth".to_string(),
                op: PredicateOp::GreaterOrEqual,
                value: json!(21),
            }],
            trusted_issuers: vec![issuer.public_key().to_hex()],
            challenge: "allowlist-ok".to_string(),
        };

        let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();

        let registry = RevocationRegistry::new();
        let trusted = vec![issuer.public_key()];
        token
            .verify(&trusted, "allowlist-ok", &registry, &[])
            .expect("21+ proof should pass when 21+ is on the allowlist");
    }
}
