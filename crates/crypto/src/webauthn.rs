use crate::hash::hash_bytes;
use crate::signature::{PublicKey, SignatureAlgorithm, SignatureError};
use base64::prelude::*;
use p256::ecdsa::{signature::Verifier, Signature as P256Signature, VerifyingKey as P256VerifyingKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum WebAuthnError {
    #[error("Invalid authenticator data")]
    InvalidAuthenticatorData,
    #[error("Invalid client data JSON")]
    InvalidClientDataJson,
    #[error("Invalid signature: {0}")]
    InvalidSignature(String),
    #[error("Challenge mismatch")]
    ChallengeMismatch,
    #[error("Invalid CBOR encoding: {0}")]
    InvalidCbor(String),
    #[error("Invalid COSE key")]
    InvalidCoseKey,
    #[error("Base64 decode error: {0}")]
    Base64Error(String),
    #[error("JSON error: {0}")]
    JsonError(String),
    #[error("Signature error: {0}")]
    SignatureError(#[from] SignatureError),
    #[error("Invalid attestation object: {0}")]
    InvalidAttestationObject(String),
    #[error("Counter replay detected")]
    CounterReplay,
    #[error("Origin mismatch")]
    OriginMismatch,
    #[error("User verification required")]
    UserVerificationRequired,
}

/// WebAuthn signature format
/// Contains the three components returned by navigator.credentials.get()
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebAuthnSignature {
    /// Base64-encoded authenticator data
    #[serde(rename = "authenticatorData")]
    pub authenticator_data: String,
    /// Base64-encoded client data JSON
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    /// Base64-encoded signature bytes
    pub signature: String,
}

impl WebAuthnSignature {
    /// Create a new WebAuthn signature from base64-encoded components
    pub fn new(authenticator_data: String, client_data_json: String, signature: String) -> Self {
        Self {
            authenticator_data,
            client_data_json,
            signature,
        }
    }

    /// Decode the authenticator data from base64
    pub fn decode_authenticator_data(&self) -> Result<Vec<u8>, WebAuthnError> {
        BASE64_STANDARD
            .decode(&self.authenticator_data)
            .map_err(|e| WebAuthnError::Base64Error(e.to_string()))
    }

    /// Decode the client data JSON from base64
    pub fn decode_client_data_json(&self) -> Result<Vec<u8>, WebAuthnError> {
        BASE64_STANDARD
            .decode(&self.client_data_json)
            .map_err(|e| WebAuthnError::Base64Error(e.to_string()))
    }

    /// Decode the signature from base64
    pub fn decode_signature(&self) -> Result<Vec<u8>, WebAuthnError> {
        BASE64_STANDARD
            .decode(&self.signature)
            .map_err(|e| WebAuthnError::Base64Error(e.to_string()))
    }

    /// Parse the client data JSON and extract the challenge
    pub fn extract_challenge(&self) -> Result<String, WebAuthnError> {
        let client_data_bytes = self.decode_client_data_json()?;
        let client_data: serde_json::Value = serde_json::from_slice(&client_data_bytes)
            .map_err(|e| WebAuthnError::JsonError(e.to_string()))?;

        client_data
            .get("challenge")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or(WebAuthnError::InvalidClientDataJson)
    }

    /// Verify the WebAuthn signature
    ///
    /// WebAuthn verification follows this process:
    /// 1. Hash the client data JSON with SHA-256
    /// 2. Concatenate authenticator_data || client_data_hash
    /// 3. Verify the signature over the concatenated data
    /// 4. Check that the challenge matches the expected value
    pub fn verify(
        &self,
        public_key: &PublicKey,
        expected_challenge: &str,
    ) -> Result<(), WebAuthnError> {
        // 1. Extract and verify challenge
        let challenge = self.extract_challenge()?;
        if challenge != expected_challenge {
            return Err(WebAuthnError::ChallengeMismatch);
        }

        self.verify_signature(public_key)
    }

    /// Verify the WebAuthn signature bound to a specific payload.
    ///
    /// The challenge in the WebAuthn response must equal base64url(SHA256(payload)).
    /// This binds the WebAuthn signature to the payload, preventing replay attacks.
    pub fn verify_payload_bound(
        &self,
        public_key: &PublicKey,
        payload: &[u8],
    ) -> Result<(), WebAuthnError> {
        // 1. Compute expected challenge: base64url(SHA256(payload))
        let payload_hash = hash_bytes(payload);
        let expected_challenge = base64url_encode(&payload_hash);

        // 2. Extract and verify challenge matches payload hash
        let challenge = self.extract_challenge()?;
        if challenge != expected_challenge {
            return Err(WebAuthnError::ChallengeMismatch);
        }

        self.verify_signature(public_key)
    }

    /// Internal method to verify the cryptographic signature
    fn verify_signature(&self, public_key: &PublicKey) -> Result<(), WebAuthnError> {
        // 1. Decode components
        let authenticator_data = self.decode_authenticator_data()?;
        let client_data_json = self.decode_client_data_json()?;
        let signature_bytes = self.decode_signature()?;

        // 2. Hash the client data JSON
        let client_data_hash = hash_bytes(&client_data_json);

        // 3. Concatenate authenticator_data || client_data_hash
        let mut message = Vec::with_capacity(authenticator_data.len() + client_data_hash.len());
        message.extend_from_slice(&authenticator_data);
        message.extend_from_slice(&client_data_hash);

        // 4. Verify the signature
        // WebAuthn uses ECDSA P-256, so we need to ensure the public key is P-256
        if public_key.algorithm() != SignatureAlgorithm::EcdsaP256 {
            return Err(WebAuthnError::InvalidSignature(
                "WebAuthn requires ECDSA P-256 keys".to_string(),
            ));
        }

        // WebAuthn returns DER-encoded signatures, try DER first, then raw format
        let sig = P256Signature::from_der(&signature_bytes)
            .or_else(|_| P256Signature::from_slice(&signature_bytes))
            .map_err(|e| WebAuthnError::InvalidSignature(format!("signature parse error: {}", e)))?;

        // Get the P-256 verifying key and verify
        let key_bytes = public_key.to_bytes();
        let verifying_key = P256VerifyingKey::from_sec1_bytes(&key_bytes)
            .map_err(|e| WebAuthnError::InvalidSignature(e.to_string()))?;

        // Verify signature - the verify() method hashes the message internally
        verifying_key
            .verify(&message, &sig)
            .map_err(|e| WebAuthnError::InvalidSignature(e.to_string()))?;

        Ok(())
    }
}

/// Encode bytes as base64url (no padding)
fn base64url_encode(data: &[u8]) -> String {
    BASE64_STANDARD
        .encode(data)
        .replace('+', "-")
        .replace('/', "_")
        .trim_end_matches('=')
        .to_string()
}

/// COSE (CBOR Object Signing and Encryption) key format
/// Used by WebAuthn for public key credentials
#[derive(Debug, Clone)]
pub struct CoseKey {
    /// Key type (2 = EC2 for elliptic curve)
    pub kty: i64,
    /// Algorithm (-7 = ES256 for ECDSA P-256 with SHA-256)
    pub alg: i64,
    /// Curve identifier (1 = P-256)
    pub crv: i64,
    /// X coordinate (32 bytes for P-256)
    pub x: Vec<u8>,
    /// Y coordinate (32 bytes for P-256)
    pub y: Vec<u8>,
}

impl CoseKey {
    /// Parse a COSE key from CBOR bytes
    pub fn from_cbor(cbor_bytes: &[u8]) -> Result<Self, WebAuthnError> {
        let value: ciborium::Value = ciborium::from_reader(cbor_bytes)
            .map_err(|e| WebAuthnError::InvalidCbor(e.to_string()))?;

        // COSE keys are represented as CBOR maps
        let map = value
            .as_map()
            .ok_or(WebAuthnError::InvalidCoseKey)?;

        let mut kty = None;
        let mut alg = None;
        let mut crv = None;
        let mut x = None;
        let mut y = None;

        for (key, val) in map {
            let key_int = key
                .as_integer()
                .and_then(|i| i.try_into().ok())
                .ok_or(WebAuthnError::InvalidCoseKey)?;

            match key_int {
                1 => kty = val.as_integer().and_then(|i| i.try_into().ok()),
                3 => alg = val.as_integer().and_then(|i| i.try_into().ok()),
                -1 => crv = val.as_integer().and_then(|i| i.try_into().ok()),
                -2 => x = val.as_bytes().map(|b| b.to_vec()),
                -3 => y = val.as_bytes().map(|b| b.to_vec()),
                _ => {}
            }
        }

        Ok(Self {
            kty: kty.ok_or(WebAuthnError::InvalidCoseKey)?,
            alg: alg.ok_or(WebAuthnError::InvalidCoseKey)?,
            crv: crv.ok_or(WebAuthnError::InvalidCoseKey)?,
            x: x.ok_or(WebAuthnError::InvalidCoseKey)?,
            y: y.ok_or(WebAuthnError::InvalidCoseKey)?,
        })
    }

    /// Parse a COSE key from hex-encoded CBOR
    pub fn from_hex(hex_str: &str) -> Result<Self, WebAuthnError> {
        let cbor_bytes = hex::decode(hex_str)
            .map_err(|e| WebAuthnError::InvalidCbor(e.to_string()))?;
        Self::from_cbor(&cbor_bytes)
    }

    /// Parse a COSE key from base64-encoded CBOR
    pub fn from_base64(base64_str: &str) -> Result<Self, WebAuthnError> {
        let cbor_bytes = BASE64_STANDARD
            .decode(base64_str)
            .map_err(|e| WebAuthnError::Base64Error(e.to_string()))?;
        Self::from_cbor(&cbor_bytes)
    }

    /// Encode the COSE key to CBOR bytes
    pub fn to_cbor(&self) -> Result<Vec<u8>, WebAuthnError> {
        use ciborium::Value;

        let map = vec![
            (Value::Integer(1.into()), Value::Integer(self.kty.into())),
            (Value::Integer(3.into()), Value::Integer(self.alg.into())),
            (Value::Integer((-1i64).into()), Value::Integer(self.crv.into())),
            (Value::Integer((-2i64).into()), Value::Bytes(self.x.clone())),
            (Value::Integer((-3i64).into()), Value::Bytes(self.y.clone())),
        ];

        let mut cbor_bytes = Vec::new();
        ciborium::into_writer(&Value::Map(map), &mut cbor_bytes)
            .map_err(|e| WebAuthnError::InvalidCbor(e.to_string()))?;

        Ok(cbor_bytes)
    }

    /// Encode the COSE key to base64
    pub fn to_base64(&self) -> Result<String, WebAuthnError> {
        let cbor_bytes = self.to_cbor()?;
        Ok(BASE64_STANDARD.encode(&cbor_bytes))
    }

    /// Convert the COSE key to a P-256 public key
    pub fn to_public_key(&self) -> Result<PublicKey, WebAuthnError> {
        // Verify this is a P-256 key
        if self.kty != 2 {
            // 2 = EC2 (elliptic curve)
            return Err(WebAuthnError::InvalidCoseKey);
        }
        if self.alg != -7 {
            // -7 = ES256 (ECDSA P-256 with SHA-256)
            return Err(WebAuthnError::InvalidCoseKey);
        }
        if self.crv != 1 {
            // 1 = P-256 curve
            return Err(WebAuthnError::InvalidCoseKey);
        }

        // Construct SEC1-encoded public key: 0x04 || x || y
        let mut sec1_bytes = Vec::with_capacity(65);
        sec1_bytes.push(0x04); // Uncompressed point indicator
        sec1_bytes.extend_from_slice(&self.x);
        sec1_bytes.extend_from_slice(&self.y);

        PublicKey::from_bytes_with_algorithm(&sec1_bytes, SignatureAlgorithm::EcdsaP256)
            .map_err(WebAuthnError::SignatureError)
    }
}

// ============================================================================
// Attestation Support for WebAuthn Registration
// ============================================================================

/// Parsed authenticator data from WebAuthn
#[derive(Debug, Clone)]
pub struct AuthenticatorData {
    /// SHA-256 hash of the RP ID (relying party origin)
    pub rp_id_hash: [u8; 32],
    /// Flags byte
    pub flags: AuthenticatorFlags,
    /// Signature counter (4 bytes, big-endian)
    pub counter: u32,
    /// Attested credential data (present only in registration)
    pub attested_credential_data: Option<AttestedCredentialData>,
    /// Extensions (if present)
    pub extensions: Option<Vec<u8>>,
}

/// Authenticator flags parsed from the flags byte
#[derive(Debug, Clone, Copy)]
pub struct AuthenticatorFlags {
    /// User present (UP)
    pub user_present: bool,
    /// User verified (UV) - biometric or PIN was used
    pub user_verified: bool,
    /// Backup eligibility (BE)
    pub backup_eligible: bool,
    /// Backup state (BS)
    pub backup_state: bool,
    /// Attested credential data present (AT)
    pub attested_credential_data_present: bool,
    /// Extension data present (ED)
    pub extension_data_present: bool,
}

impl AuthenticatorFlags {
    /// Parse flags from a single byte
    pub fn from_byte(byte: u8) -> Self {
        Self {
            user_present: byte & 0x01 != 0,
            user_verified: byte & 0x04 != 0,
            backup_eligible: byte & 0x08 != 0,
            backup_state: byte & 0x10 != 0,
            attested_credential_data_present: byte & 0x40 != 0,
            extension_data_present: byte & 0x80 != 0,
        }
    }
}

/// Attested credential data from registration
#[derive(Debug, Clone)]
pub struct AttestedCredentialData {
    /// Authenticator attestation GUID (16 bytes)
    pub aaguid: [u8; 16],
    /// Credential ID (variable length)
    pub credential_id: Vec<u8>,
    /// Public key in COSE format
    pub credential_public_key: CoseKey,
}

impl AuthenticatorData {
    /// Parse authenticator data from raw bytes
    pub fn parse(data: &[u8]) -> Result<Self, WebAuthnError> {
        if data.len() < 37 {
            return Err(WebAuthnError::InvalidAuthenticatorData);
        }

        // RP ID hash (32 bytes)
        let mut rp_id_hash = [0u8; 32];
        rp_id_hash.copy_from_slice(&data[0..32]);

        // Flags (1 byte)
        let flags = AuthenticatorFlags::from_byte(data[32]);

        // Counter (4 bytes, big-endian)
        let counter = u32::from_be_bytes([data[33], data[34], data[35], data[36]]);

        let mut offset = 37;
        let mut attested_credential_data = None;
        let mut extensions = None;

        // Parse attested credential data if present
        if flags.attested_credential_data_present {
            if data.len() < offset + 18 {
                return Err(WebAuthnError::InvalidAuthenticatorData);
            }

            // AAGUID (16 bytes)
            let mut aaguid = [0u8; 16];
            aaguid.copy_from_slice(&data[offset..offset + 16]);
            offset += 16;

            // Credential ID length (2 bytes, big-endian)
            let cred_id_len = u16::from_be_bytes([data[offset], data[offset + 1]]) as usize;
            offset += 2;

            if data.len() < offset + cred_id_len {
                return Err(WebAuthnError::InvalidAuthenticatorData);
            }

            // Credential ID
            let credential_id = data[offset..offset + cred_id_len].to_vec();
            offset += cred_id_len;

            // Public key (CBOR encoded, variable length)
            let credential_public_key = CoseKey::from_cbor(&data[offset..])?;

            // Calculate CBOR length by re-encoding (imperfect but functional)
            let cbor_len = credential_public_key.to_cbor()?.len();
            offset += cbor_len;

            attested_credential_data = Some(AttestedCredentialData {
                aaguid,
                credential_id,
                credential_public_key,
            });
        }

        // Parse extensions if present
        if flags.extension_data_present && offset < data.len() {
            extensions = Some(data[offset..].to_vec());
        }

        Ok(Self {
            rp_id_hash,
            flags,
            counter,
            attested_credential_data,
            extensions,
        })
    }
}

/// Attestation object from WebAuthn registration
#[derive(Debug)]
pub struct AttestationObject {
    /// Attestation format (e.g., "none", "packed", "fido-u2f")
    pub fmt: String,
    /// Authenticator data
    pub auth_data: AuthenticatorData,
    /// Attestation statement (format-specific)
    pub att_stmt: serde_json::Value,
}

impl AttestationObject {
    /// Parse attestation object from CBOR bytes
    pub fn from_cbor(cbor_bytes: &[u8]) -> Result<Self, WebAuthnError> {
        let value: ciborium::Value = ciborium::from_reader(cbor_bytes)
            .map_err(|e| WebAuthnError::InvalidAttestationObject(e.to_string()))?;

        let map = value
            .as_map()
            .ok_or_else(|| WebAuthnError::InvalidAttestationObject("Not a map".to_string()))?;

        let mut fmt = None;
        let mut auth_data_bytes = None;
        let mut att_stmt = None;

        for (key, val) in map {
            let key_str = key
                .as_text()
                .ok_or_else(|| WebAuthnError::InvalidAttestationObject("Key not text".to_string()))?;

            match key_str {
                "fmt" => {
                    fmt = val.as_text().map(|s| s.to_string());
                }
                "authData" => {
                    auth_data_bytes = val.as_bytes().map(|b| b.to_vec());
                }
                "attStmt" => {
                    // Convert CBOR value to JSON for easier handling
                    att_stmt = Some(cbor_to_json(val)?);
                }
                _ => {}
            }
        }

        let fmt = fmt.ok_or_else(|| {
            WebAuthnError::InvalidAttestationObject("Missing fmt".to_string())
        })?;

        let auth_data_bytes = auth_data_bytes.ok_or_else(|| {
            WebAuthnError::InvalidAttestationObject("Missing authData".to_string())
        })?;

        let auth_data = AuthenticatorData::parse(&auth_data_bytes)?;

        Ok(Self {
            fmt,
            auth_data,
            att_stmt: att_stmt.unwrap_or(serde_json::Value::Object(Default::default())),
        })
    }

    /// Parse attestation object from base64-encoded bytes
    pub fn from_base64(base64_str: &str) -> Result<Self, WebAuthnError> {
        let bytes = BASE64_STANDARD
            .decode(base64_str)
            .map_err(|e| WebAuthnError::Base64Error(e.to_string()))?;
        Self::from_cbor(&bytes)
    }

    /// Verify the attestation based on format
    pub fn verify_attestation(&self) -> Result<(), WebAuthnError> {
        match self.fmt.as_str() {
            "none" => self.verify_none_attestation(),
            "packed" => self.verify_packed_attestation(),
            fmt => Err(WebAuthnError::InvalidAttestationObject(
                format!("Unsupported attestation format: {}", fmt),
            )),
        }
    }

    /// Verify "none" format attestation
    /// For "none" format, att_stmt must be empty
    fn verify_none_attestation(&self) -> Result<(), WebAuthnError> {
        if !self.att_stmt.is_object()
            || !self
                .att_stmt
                .as_object()
                .map_or(false, |m| m.is_empty())
        {
            return Err(WebAuthnError::InvalidAttestationObject(
                "Expected empty att_stmt for 'none' format".into(),
            ));
        }
        Ok(())
    }

    /// Verify "packed" format attestation
    /// For now, validates required fields exist without full certificate validation
    fn verify_packed_attestation(&self) -> Result<(), WebAuthnError> {
        let att_stmt = self.att_stmt.as_object().ok_or_else(|| {
            WebAuthnError::InvalidAttestationObject("Expected object for packed att_stmt".into())
        })?;

        // Verify required fields exist
        if !att_stmt.contains_key("alg") || !att_stmt.contains_key("sig") {
            return Err(WebAuthnError::InvalidAttestationObject(
                "Missing required fields in packed attestation".into(),
            ));
        }

        Ok(())
    }
}

/// Extracted credential from WebAuthn registration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedCredential {
    /// Base64-encoded credential ID
    pub credential_id: String,
    /// Base64-encoded COSE public key
    pub public_key: String,
    /// Initial signature counter
    pub counter: u32,
    /// AAGUID as hex string
    pub aaguid: String,
    /// Transports (if provided by the client)
    pub transports: Vec<String>,
}

/// Registration response from WebAuthn navigator.credentials.create()
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistrationResponse {
    /// Base64-encoded attestation object
    #[serde(rename = "attestationObject")]
    pub attestation_object: String,
    /// Base64-encoded client data JSON
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    /// Optional transports (provided by the authenticator)
    #[serde(default)]
    pub transports: Vec<String>,
}

impl RegistrationResponse {
    /// Verify the registration response and extract the credential
    pub fn verify(
        &self,
        expected_challenge: &str,
        expected_origin: &str,
        expected_rp_id: &str,
        require_user_verification: bool,
    ) -> Result<ExtractedCredential, WebAuthnError> {
        // 1. Decode and parse client data JSON
        let client_data_bytes = BASE64_STANDARD
            .decode(&self.client_data_json)
            .map_err(|e| WebAuthnError::Base64Error(e.to_string()))?;

        let client_data: serde_json::Value = serde_json::from_slice(&client_data_bytes)
            .map_err(|e| WebAuthnError::JsonError(e.to_string()))?;

        // 2. Verify type is "webauthn.create"
        let request_type = client_data
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or(WebAuthnError::InvalidClientDataJson)?;

        if request_type != "webauthn.create" {
            return Err(WebAuthnError::InvalidClientDataJson);
        }

        // 3. Verify challenge matches
        let challenge = client_data
            .get("challenge")
            .and_then(|v| v.as_str())
            .ok_or(WebAuthnError::InvalidClientDataJson)?;

        if challenge != expected_challenge {
            return Err(WebAuthnError::ChallengeMismatch);
        }

        // 4. Verify origin matches
        let origin = client_data
            .get("origin")
            .and_then(|v| v.as_str())
            .ok_or(WebAuthnError::InvalidClientDataJson)?;

        if origin != expected_origin {
            return Err(WebAuthnError::OriginMismatch);
        }

        // 5. Parse attestation object
        let attestation = AttestationObject::from_base64(&self.attestation_object)?;

        // 6. Verify attestation format and statement
        attestation.verify_attestation()?;

        // 7. Verify RP ID hash
        let expected_rp_id_hash = hash_bytes(expected_rp_id.as_bytes());
        if attestation.auth_data.rp_id_hash != expected_rp_id_hash.as_slice() {
            return Err(WebAuthnError::OriginMismatch);
        }

        // 8. Verify flags
        if !attestation.auth_data.flags.user_present {
            return Err(WebAuthnError::UserVerificationRequired);
        }

        if require_user_verification && !attestation.auth_data.flags.user_verified {
            return Err(WebAuthnError::UserVerificationRequired);
        }

        // 9. Extract credential data
        let attested_data = attestation
            .auth_data
            .attested_credential_data
            .ok_or(WebAuthnError::InvalidAttestationObject(
                "No attested credential data".to_string(),
            ))?;

        // 10. Verify the public key is valid by attempting to parse it
        attested_data.credential_public_key.to_public_key()?;

        // 11. Return extracted credential
        Ok(ExtractedCredential {
            credential_id: BASE64_STANDARD.encode(&attested_data.credential_id),
            public_key: attested_data.credential_public_key.to_base64()?,
            counter: attestation.auth_data.counter,
            aaguid: hex::encode(attested_data.aaguid),
            transports: self.transports.clone(),
        })
    }
}

/// Authentication response from WebAuthn navigator.credentials.get()
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthenticationResponse {
    /// Base64-encoded credential ID
    #[serde(rename = "credentialId")]
    pub credential_id: String,
    /// Base64-encoded authenticator data
    #[serde(rename = "authenticatorData")]
    pub authenticator_data: String,
    /// Base64-encoded client data JSON
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    /// Base64-encoded signature
    pub signature: String,
    /// Optional user handle
    #[serde(rename = "userHandle")]
    pub user_handle: Option<String>,
}

impl AuthenticationResponse {
    /// Verify the authentication response
    pub fn verify(
        &self,
        credential_public_key: &str,
        stored_counter: u32,
        expected_challenge: &str,
        expected_origin: &str,
        expected_rp_id: &str,
        require_user_verification: bool,
    ) -> Result<u32, WebAuthnError> {
        // 1. Decode and parse client data JSON
        let client_data_bytes = BASE64_STANDARD
            .decode(&self.client_data_json)
            .map_err(|e| WebAuthnError::Base64Error(e.to_string()))?;

        let client_data: serde_json::Value = serde_json::from_slice(&client_data_bytes)
            .map_err(|e| WebAuthnError::JsonError(e.to_string()))?;

        // 2. Verify type is "webauthn.get"
        let request_type = client_data
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or(WebAuthnError::InvalidClientDataJson)?;

        if request_type != "webauthn.get" {
            return Err(WebAuthnError::InvalidClientDataJson);
        }

        // 3. Verify challenge matches
        let challenge = client_data
            .get("challenge")
            .and_then(|v| v.as_str())
            .ok_or(WebAuthnError::InvalidClientDataJson)?;

        if challenge != expected_challenge {
            return Err(WebAuthnError::ChallengeMismatch);
        }

        // 4. Verify origin matches
        let origin = client_data
            .get("origin")
            .and_then(|v| v.as_str())
            .ok_or(WebAuthnError::InvalidClientDataJson)?;

        if origin != expected_origin {
            return Err(WebAuthnError::OriginMismatch);
        }

        // 5. Decode authenticator data
        let auth_data_bytes = BASE64_STANDARD
            .decode(&self.authenticator_data)
            .map_err(|e| WebAuthnError::Base64Error(e.to_string()))?;

        let auth_data = AuthenticatorData::parse(&auth_data_bytes)?;

        // 6. Verify RP ID hash
        let expected_rp_id_hash = hash_bytes(expected_rp_id.as_bytes());
        if auth_data.rp_id_hash != expected_rp_id_hash.as_slice() {
            return Err(WebAuthnError::OriginMismatch);
        }

        // 7. Verify flags
        if !auth_data.flags.user_present {
            return Err(WebAuthnError::UserVerificationRequired);
        }

        if require_user_verification && !auth_data.flags.user_verified {
            return Err(WebAuthnError::UserVerificationRequired);
        }

        // 8. Verify counter (prevent replay attacks)
        if auth_data.counter > 0 && auth_data.counter <= stored_counter {
            return Err(WebAuthnError::CounterReplay);
        }

        // 9. Decode public key and verify signature
        let cose_key_bytes = BASE64_STANDARD
            .decode(credential_public_key)
            .map_err(|e| WebAuthnError::Base64Error(e.to_string()))?;

        let cose_key = CoseKey::from_cbor(&cose_key_bytes)?;
        let public_key = cose_key.to_public_key()?;

        // 10. Hash client data JSON
        let client_data_hash = hash_bytes(&client_data_bytes);

        // 11. Concatenate authenticator_data || client_data_hash
        let mut signed_data = Vec::with_capacity(auth_data_bytes.len() + client_data_hash.len());
        signed_data.extend_from_slice(&auth_data_bytes);
        signed_data.extend_from_slice(&client_data_hash);

        // 12. Verify signature
        let signature_bytes = BASE64_STANDARD
            .decode(&self.signature)
            .map_err(|e| WebAuthnError::Base64Error(e.to_string()))?;

        // WebAuthn returns DER-encoded signatures, try DER first, then raw format
        let sig = P256Signature::from_der(&signature_bytes)
            .or_else(|_| P256Signature::from_slice(&signature_bytes))
            .map_err(|e| WebAuthnError::InvalidSignature(format!("signature parse error: {}", e)))?;

        let key_bytes = public_key.to_bytes();
        let verifying_key = P256VerifyingKey::from_sec1_bytes(&key_bytes)
            .map_err(|e| WebAuthnError::InvalidSignature(e.to_string()))?;

        // Verify signature - verify() hashes the message internally
        verifying_key
            .verify(&signed_data, &sig)
            .map_err(|e| WebAuthnError::InvalidSignature(e.to_string()))?;

        // Return the new counter value
        Ok(auth_data.counter)
    }
}

/// Helper function to convert CBOR value to JSON
fn cbor_to_json(value: &ciborium::Value) -> Result<serde_json::Value, WebAuthnError> {
    match value {
        ciborium::Value::Integer(i) => {
            let n: i128 = (*i).into();
            Ok(serde_json::Value::Number(
                serde_json::Number::from(n as i64),
            ))
        }
        ciborium::Value::Bytes(b) => Ok(serde_json::Value::String(BASE64_STANDARD.encode(b))),
        ciborium::Value::Float(f) => Ok(serde_json::Value::Number(
            serde_json::Number::from_f64(*f).unwrap_or(serde_json::Number::from(0)),
        )),
        ciborium::Value::Text(s) => Ok(serde_json::Value::String(s.clone())),
        ciborium::Value::Bool(b) => Ok(serde_json::Value::Bool(*b)),
        ciborium::Value::Null => Ok(serde_json::Value::Null),
        ciborium::Value::Array(arr) => {
            let items: Result<Vec<_>, _> = arr.iter().map(cbor_to_json).collect();
            Ok(serde_json::Value::Array(items?))
        }
        ciborium::Value::Map(map) => {
            let mut obj = serde_json::Map::new();
            for (k, v) in map {
                let key = match k {
                    ciborium::Value::Text(s) => s.clone(),
                    ciborium::Value::Integer(i) => {
                        let n: i128 = (*i).into();
                        n.to_string()
                    }
                    _ => continue,
                };
                obj.insert(key, cbor_to_json(v)?);
            }
            Ok(serde_json::Value::Object(obj))
        }
        ciborium::Value::Tag(_, inner) => cbor_to_json(inner),
        _ => Ok(serde_json::Value::Null),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signature::KeyPair;

    #[test]
    fn test_webauthn_signature_parsing() {
        let sig = WebAuthnSignature::new(
            BASE64_STANDARD.encode(b"authenticator_data"),
            BASE64_STANDARD.encode(b"{\"challenge\":\"test\"}"),
            BASE64_STANDARD.encode(b"signature"),
        );

        assert!(sig.decode_authenticator_data().is_ok());
        assert!(sig.decode_client_data_json().is_ok());
        assert!(sig.decode_signature().is_ok());
    }

    #[test]
    fn test_challenge_extraction() {
        let client_data = r#"{"challenge":"test_challenge","origin":"https://example.com"}"#;
        let sig = WebAuthnSignature::new(
            BASE64_STANDARD.encode(b"authenticator_data"),
            BASE64_STANDARD.encode(client_data.as_bytes()),
            BASE64_STANDARD.encode(b"signature"),
        );

        let challenge = sig.extract_challenge().unwrap();
        assert_eq!(challenge, "test_challenge");
    }

    #[test]
    fn test_cose_key_p256() {
        // Create a test COSE key for P-256
        // This is a simplified CBOR map: {1: 2, 3: -7, -1: 1, -2: x, -3: y}
        let keypair = KeyPair::generate_with_algorithm(SignatureAlgorithm::EcdsaP256);
        let public_key = keypair.public_key();

        // For this test, we just verify the public key can be created
        assert_eq!(public_key.algorithm(), SignatureAlgorithm::EcdsaP256);
    }
}
