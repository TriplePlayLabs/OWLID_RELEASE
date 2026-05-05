use crate::error::ProofSystemError;
use crate::schema::CredentialSchema;
use owl_crypto::{generate_salt, KeyPair, MerkleProof, MerkleTree, PublicKey, Signature};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Document represents a data object in the proof system
/// Contains attributes signed by an issuer
#[derive(Debug, Clone)]
pub struct Document {
    attributes: BTreeMap<String, serde_json::Value>,
}

impl Document {
    /// Create a new document with attributes
    /// Must include 'issuerKey' and either 'ownerKey' or 'ownerKeys' as per spec
    pub fn new(attributes: BTreeMap<String, serde_json::Value>) -> Result<Self, ProofSystemError> {
        // Validate mandatory attributes
        if !attributes.contains_key("issuerKey") {
            return Err(ProofSystemError::MissingAttribute("issuerKey".to_string()));
        }

        // Must have either ownerKey (single) or ownerKeys (multiple)
        let has_owner = attributes.contains_key("ownerKey");
        let has_owners = attributes.contains_key("ownerKeys");

        if !has_owner && !has_owners {
            return Err(ProofSystemError::MissingAttribute(
                "ownerKey or ownerKeys".to_string()
            ));
        }

        Ok(Self { attributes })
    }

    /// Create a new document with schema validation (T-008)
    /// Validates attributes against the schema before creating the document.
    pub fn new_with_schema(
        attributes: BTreeMap<String, serde_json::Value>,
        schema: &CredentialSchema,
    ) -> Result<Self, ProofSystemError> {
        schema.validate(&attributes)?;
        Self::new(attributes)
    }

    /// Issue a document by signing it with the issuer's key
    /// Generates a per-document salt and builds a salted Merkle tree
    /// Returns a ProofDocument that can be stored by the owner
    pub fn issue(self, issuer_keypair: &KeyPair) -> ProofDocument {
        // Generate per-document salt for rainbow table protection
        let salt = generate_salt();

        // Build salted Merkle tree from attributes
        let merkle_tree = MerkleTree::from_attributes_salted(&self.attributes, &salt);
        let root_hash = merkle_tree.root_hash_hex();

        // Capture leaf hashes for serialization round-trip
        let leaf_hashes: Vec<(String, String)> = self
            .attributes
            .keys()
            .zip(merkle_tree.leaves().iter())
            .map(|(k, h)| (k.clone(), hex::encode(h)))
            .collect();

        // Sign the root hash
        let signature = issuer_keypair.sign(root_hash.as_bytes());

        ProofDocument {
            root_hash,
            attributes: self.attributes,
            signature,
            salt: Some(salt),
            leaf_hashes: Some(leaf_hashes),
            merkle_tree,
        }
    }

    pub fn attributes(&self) -> &BTreeMap<String, serde_json::Value> {
        &self.attributes
    }
}

/// ProofDocument is an issued document with signature
/// Can be used to generate tokens with selective disclosure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProofDocument {
    root_hash: String,
    attributes: BTreeMap<String, serde_json::Value>,
    signature: Signature,
    /// Per-document salt for rainbow table protection (T-004)
    #[serde(skip_serializing_if = "Option::is_none")]
    salt: Option<String>,
    /// Pre-computed leaf hashes for serialization round-trip (T-006)
    /// Stored as (attribute_key, hex_hash) pairs
    #[serde(skip_serializing_if = "Option::is_none")]
    leaf_hashes: Option<Vec<(String, String)>>,
    #[serde(skip, default = "default_merkle_tree")]
    merkle_tree: MerkleTree,
}

fn default_merkle_tree() -> MerkleTree {
    MerkleTree::from_attributes(&BTreeMap::new())
}

impl ProofDocument {
    /// Reconstruct merkle tree after deserialization
    fn ensure_merkle_tree(&mut self) {
        if self.merkle_tree.root_hash_hex() != self.root_hash {
            // T-006: Try to reconstruct from leaf_hashes first (preserves exact hashes)
            if let Some(ref leaf_hashes) = self.leaf_hashes {
                let hashes: Vec<(String, [u8; 32])> = leaf_hashes
                    .iter()
                    .filter_map(|(k, h)| {
                        hex::decode(h).ok().and_then(|bytes| {
                            let arr: [u8; 32] = bytes.try_into().ok()?;
                            Some((k.clone(), arr))
                        })
                    })
                    .collect();
                let tree = MerkleTree::from_leaf_hashes(&hashes);
                if tree.root_hash_hex() == self.root_hash {
                    self.merkle_tree = tree;
                    return;
                }
            }

            // Fallback: rebuild from attributes with salt if available
            if let Some(ref salt) = self.salt {
                self.merkle_tree =
                    MerkleTree::from_attributes_salted(&self.attributes, salt);
            } else {
                // Legacy unsalted documents
                tracing::warn!("Reconstructing Merkle tree without salt (legacy document)");
                self.merkle_tree = MerkleTree::from_attributes(&self.attributes);
            }
        }
    }

    /// Get the salt for this document (if any)
    pub fn salt(&self) -> Option<&str> {
        self.salt.as_deref()
    }

    /// Verify the document signature
    pub fn verify(&mut self, issuer_public_key: &PublicKey) -> Result<(), ProofSystemError> {
        self.ensure_merkle_tree();
        issuer_public_key.verify(self.root_hash.as_bytes(), &self.signature)?;
        Ok(())
    }

    /// Generate a proof of inclusion for specific attributes
    pub fn generate_proof(
        &mut self,
        attribute_keys: &[String],
    ) -> Result<MerkleProof, ProofSystemError> {
        self.ensure_merkle_tree();
        self.merkle_tree
            .generate_proof(attribute_keys)
            .map_err(ProofSystemError::InvalidProof)
    }

    /// Get the root hash
    pub fn root_hash(&self) -> &str {
        &self.root_hash
    }

    /// Get the signature
    pub fn signature(&self) -> &Signature {
        &self.signature
    }

    /// Get specific attribute value
    pub fn get_attribute(&self, key: &str) -> Option<&serde_json::Value> {
        self.attributes.get(key)
    }

    /// Get all attributes
    pub fn attributes(&self) -> &BTreeMap<String, serde_json::Value> {
        &self.attributes
    }

    /// Get the leaf hash for a specific attribute key in the Merkle tree
    pub fn leaf_hash_hex(&mut self, key: &str) -> Option<String> {
        self.ensure_merkle_tree();
        self.merkle_tree.leaf_hash_hex(key)
    }

    /// Get the issuer public key from attributes
    pub fn issuer_key(&self) -> Result<PublicKey, ProofSystemError> {
        let issuer_key_value = self
            .attributes
            .get("issuerKey")
            .ok_or_else(|| ProofSystemError::MissingAttribute("issuerKey".to_string()))?;

        let issuer_key_str = issuer_key_value.as_str().ok_or_else(|| {
            ProofSystemError::InvalidProof("issuerKey must be a string".to_string())
        })?;

        PublicKey::from_hex(issuer_key_str).map_err(ProofSystemError::SignatureError)
    }

    /// Get the owner public key from attributes (single owner)
    pub fn owner_key(&self) -> Result<PublicKey, ProofSystemError> {
        let owner_key_value = self
            .attributes
            .get("ownerKey")
            .ok_or_else(|| ProofSystemError::MissingAttribute("ownerKey".to_string()))?;

        let owner_key_str = owner_key_value.as_str().ok_or_else(|| {
            ProofSystemError::InvalidProof("ownerKey must be a string".to_string())
        })?;

        PublicKey::from_hex(owner_key_str).map_err(ProofSystemError::SignatureError)
    }

    /// Get all owner public keys from attributes (supports both single and multiple owners)
    pub fn owner_keys(&self) -> Result<Vec<PublicKey>, ProofSystemError> {
        // Check for multiple owners first
        if let Some(owner_keys_value) = self.attributes.get("ownerKeys") {
            let owner_keys_array = owner_keys_value.as_array().ok_or_else(|| {
                ProofSystemError::InvalidProof("ownerKeys must be an array".to_string())
            })?;

            let mut keys = Vec::new();
            for (i, key_value) in owner_keys_array.iter().enumerate() {
                let key_str = key_value.as_str().ok_or_else(|| {
                    ProofSystemError::InvalidProof(format!(
                        "ownerKeys[{}] must be a string",
                        i
                    ))
                })?;

                let key = PublicKey::from_hex(key_str)
                    .map_err(ProofSystemError::SignatureError)?;
                keys.push(key);
            }

            if keys.is_empty() {
                return Err(ProofSystemError::InvalidProof(
                    "ownerKeys array cannot be empty".to_string()
                ));
            }

            return Ok(keys);
        }

        // Fallback to single owner
        if let Ok(single_key) = self.owner_key() {
            return Ok(vec![single_key]);
        }

        Err(ProofSystemError::MissingAttribute(
            "ownerKey or ownerKeys".to_string()
        ))
    }

    /// Check if this is a multi-owner document
    pub fn is_multi_owner(&self) -> bool {
        self.attributes.contains_key("ownerKeys")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_document_creation() {
        let issuer = KeyPair::generate();
        let owner = KeyPair::generate();

        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
        attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
        attrs.insert("name".to_string(), json!("John Doe"));
        attrs.insert("age".to_string(), json!(30));

        let doc = Document::new(attrs).unwrap();
        assert!(doc.attributes().contains_key("name"));
    }

    #[test]
    fn test_document_issuance() {
        let issuer = KeyPair::generate();
        let owner = KeyPair::generate();

        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
        attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
        attrs.insert("name".to_string(), json!("John Doe"));

        let doc = Document::new(attrs).unwrap();
        let mut proof_doc = doc.issue(&issuer);

        // Verify signature
        assert!(proof_doc.verify(&issuer.public_key()).is_ok());
    }

    #[test]
    fn test_proof_generation() {
        let issuer = KeyPair::generate();
        let owner = KeyPair::generate();

        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
        attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
        attrs.insert("name".to_string(), json!("John Doe"));
        attrs.insert("age".to_string(), json!(30));

        let doc = Document::new(attrs).unwrap();
        let mut proof_doc = doc.issue(&issuer);

        let proof = proof_doc.generate_proof(&["name".to_string()]).unwrap();
        assert_eq!(proof.root_hash_hex(), proof_doc.root_hash());
    }

    #[test]
    fn test_multi_owner_document() {
        let issuer = KeyPair::generate();
        let owner1 = KeyPair::generate();
        let owner2 = KeyPair::generate();
        let owner3 = KeyPair::generate();

        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
        attrs.insert("ownerKeys".to_string(), json!([
            owner1.public_key().to_hex(),
            owner2.public_key().to_hex(),
            owner3.public_key().to_hex()
        ]));
        attrs.insert("name".to_string(), json!("Shared Document"));
        attrs.insert("type".to_string(), json!("joint-ownership"));

        let doc = Document::new(attrs).unwrap();
        let mut proof_doc = doc.issue(&issuer);

        // Verify it's a multi-owner document
        assert!(proof_doc.is_multi_owner());

        // Verify we can get all owner keys
        let owner_keys = proof_doc.owner_keys().unwrap();
        assert_eq!(owner_keys.len(), 3);

        // Verify signature
        assert!(proof_doc.verify(&issuer.public_key()).is_ok());
    }

    #[test]
    fn test_single_owner_backwards_compatibility() {
        let issuer = KeyPair::generate();
        let owner = KeyPair::generate();

        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
        attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
        attrs.insert("name".to_string(), json!("Single Owner Doc"));

        let doc = Document::new(attrs).unwrap();
        let mut proof_doc = doc.issue(&issuer);

        // Should not be multi-owner
        assert!(!proof_doc.is_multi_owner());

        // owner_keys() should return vec with single key
        let owner_keys = proof_doc.owner_keys().unwrap();
        assert_eq!(owner_keys.len(), 1);

        // owner_key() should still work
        let single_key = proof_doc.owner_key().unwrap();
        assert_eq!(single_key.to_hex(), owner.public_key().to_hex());
    }

    #[test]
    fn test_empty_owner_keys_rejected() {
        let issuer = KeyPair::generate();

        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
        attrs.insert("ownerKeys".to_string(), json!([]));
        attrs.insert("name".to_string(), json!("Invalid Doc"));

        let doc = Document::new(attrs).unwrap();
        let mut proof_doc = doc.issue(&issuer);

        // Empty ownerKeys array should be rejected
        assert!(proof_doc.owner_keys().is_err());
    }
}
