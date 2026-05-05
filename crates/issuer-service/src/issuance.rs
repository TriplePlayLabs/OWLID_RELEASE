//! Direct Credential Issuance
//!
//! This module handles credential issuance directly without HTTP calls.
//! It replaces the previous HTTP-based credential bridge to the external issuer service.

use crate::db::CredentialRepository;
use crate::error::{IdpError, Result};
use owl_crypto::{KeyPair, PublicKey, SignatureAlgorithm};
use owl_proof_system::document::{Document, ProofDocument};
use owl_proof_system::predicates::{self, PredicateParams};
use serde_json::Value;
use std::collections::BTreeMap;

/// Pick the predicate ids the credential can actually prove given its
/// attribute shape. For set-membership predicates (e.g. `nationality:eu`),
/// also check that the attribute value canonicalizes onto the dataset —
/// otherwise the holder couldn't prove membership anyway, and advertising
/// the predicate would mislead verifiers.
fn derive_available_predicates(attrs: &BTreeMap<String, Value>) -> Vec<String> {
    let mut present: Vec<&str> = Vec::new();
    for (k, v) in attrs.iter() {
        if v.is_null() {
            continue;
        }
        present.push(k.as_str());
    }

    let mut out = Vec::new();
    for pred in predicates::for_attributes(&present) {
        if let PredicateParams::SetName(name) = pred.params {
            let value = match attrs.get(pred.attribute).and_then(|v| v.as_str()) {
                Some(v) => v,
                None => continue,
            };
            let dataset = match owl_zk_circuits::data::lookup(name) {
                Some(d) => d,
                None => continue,
            };
            if dataset.canonicalize(value).is_none() {
                continue;
            }
        }
        out.push(pred.id.to_string());
    }
    out
}

/// Issue a credential directly without HTTP calls
///
/// This function:
/// 1. Parses the issuer and owner keys
/// 2. Creates a Document with the provided attributes
/// 3. Tags it with the predicate ids it can prove (filtered by the actual
///    attribute shape — e.g. `nationality:eu` only when nationality is on the
///    EU set)
/// 4. Issues (signs) the document with the issuer's key
/// 5. Optionally stores the credential in the database
///
/// # Arguments
///
/// * `issuer_private_key` - Hex-encoded issuer private key bytes
/// * `owner_public_key` - Hex-encoded owner public key
/// * `attributes` - Credential attributes to include
/// * `key_algorithm` - Owner key algorithm
/// * `credential_repo` - Optional repository to store the credential
///
/// # Returns
///
/// The issued `ProofDocument` containing the credential
pub async fn issue_credential_direct(
    issuer_private_key: &str,
    owner_public_key: &str,
    key_algorithm: SignatureAlgorithm,
    attributes: BTreeMap<String, Value>,
    credential_repo: Option<&CredentialRepository>,
) -> Result<ProofDocument> {
    // Parse issuer keypair from hex
    let issuer_key_bytes = hex::decode(issuer_private_key)
        .map_err(|_| IdpError::InvalidField {
            field: "issuer_private_key".to_string(),
            reason: "Invalid hex format".to_string(),
        })?;

    let issuer_keypair = KeyPair::from_bytes(&issuer_key_bytes)
        .map_err(|_| IdpError::InvalidField {
            field: "issuer_private_key".to_string(),
            reason: "Invalid key format".to_string(),
        })?;

    let issuer_public_key_hex = issuer_keypair.public_key().to_hex();

    let owner_pk = PublicKey::from_hex_with_algorithm(owner_public_key, key_algorithm).map_err(|e| {
        IdpError::InvalidField {
            field: "owner_public_key".to_string(),
            reason: format!("Invalid public key format: {}", e),
        }
    })?;

    // Prepare attributes - add mandatory issuerKey and ownerKey
    let mut attrs = attributes;
    attrs.insert("issuerKey".to_string(), serde_json::json!(issuer_public_key_hex));
    attrs.insert("ownerKey".to_string(), serde_json::json!(owner_pk.to_hex()));

    let available_predicates = derive_available_predicates(&attrs);

    // Create document
    let document = Document::new(attrs)
        .map_err(|e| IdpError::CredentialIssuance(format!("Failed to create document: {}", e)))?
        .with_available_predicates(available_predicates);

    // Issue credential (sign with issuer key)
    let proof_document = document.issue(&issuer_keypair);

    // Optionally store in database
    if let Some(repo) = credential_repo {
        let credential_data = serde_json::to_value(&proof_document)
            .map_err(|e| IdpError::CredentialIssuance(format!("Serialization error: {}", e)))?;

        repo.store(
            proof_document.root_hash().to_string(),
            issuer_public_key_hex,
            owner_pk.to_hex(),
            credential_data,
            None, // No expiration by default
            serde_json::json!({}),
        )
        .await
        .map_err(|e| IdpError::CredentialIssuance(format!("Database error: {}", e)))?;
    }

    Ok(proof_document)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_issue_credential_direct() {
        // Generate test keypairs (Ed25519)
        let issuer_keypair = KeyPair::generate();
        let owner_keypair = KeyPair::generate();

        let issuer_private_key = hex::encode(issuer_keypair.to_bytes());
        let owner_public_key = owner_keypair.public_key().to_hex();

        let mut attributes = BTreeMap::new();
        attributes.insert("firstName".to_string(), serde_json::json!("Test"));
        attributes.insert("lastName".to_string(), serde_json::json!("User"));
        attributes.insert("isOver18".to_string(), serde_json::json!(true));

        let result = issue_credential_direct(
            &issuer_private_key,
            &owner_public_key,
            SignatureAlgorithm::Ed25519,
            attributes,
            None, // No DB storage in test
        )
        .await;

        assert!(result.is_ok());
        let proof_doc = result.unwrap();

        // Verify the document has the expected attributes
        assert!(proof_doc.root_hash().len() > 0);
    }

    #[tokio::test]
    async fn test_issue_credential_invalid_issuer_key() {
        let owner_keypair = KeyPair::generate();
        let owner_public_key = owner_keypair.public_key().to_hex();

        let attributes = BTreeMap::new();

        let result = issue_credential_direct(
            "invalid_hex",
            &owner_public_key,
            SignatureAlgorithm::Ed25519,
            attributes,
            None,
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_issue_credential_invalid_owner_key() {
        let issuer_keypair = KeyPair::generate();
        let issuer_private_key = hex::encode(issuer_keypair.to_bytes());

        let attributes = BTreeMap::new();

        let result = issue_credential_direct(
            &issuer_private_key,
            "invalid_public_key",
            SignatureAlgorithm::Ed25519,
            attributes,
            None,
        )
        .await;

        assert!(result.is_err());
    }
}
