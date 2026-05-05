#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

use owl_crypto::{
    KeyPair as OwlKeyPair, PublicKey as OwlPublicKey, Signature as OwlSignature,
};
use owl_proof_system::{
    Document as OwlDocument,
    PredicateOp as OwlPredicateOp, PredicateRequest as OwlPredicateRequest,
    PreparedToken as OwlPreparedToken, ProofDocument as OwlProofDocument,
    ProofRequest as OwlProofRequest, RevocationRegistry, Token as OwlToken,
};

// ============================================================================
// CRYPTO — KeyPair
// ============================================================================

/// An Ed25519 keypair for signing and verification.
///
/// Use `KeyPair.generate()` to create a new random keypair, or
/// `KeyPair.fromHex()` to restore one from a saved private key.
#[napi]
pub struct KeyPair {
    inner: OwlKeyPair,
}

#[napi]
impl KeyPair {
    /// Generate a new random Ed25519 keypair.
    ///
    /// @returns A new `KeyPair` with a cryptographically random private key.
    ///
    /// @example
    /// ```js
    /// const kp = KeyPair.generate()
    /// console.log(kp.publicKey().toHex()) // 64 hex chars
    /// ```
    #[napi(factory)]
    pub fn generate() -> Self {
        KeyPair { inner: OwlKeyPair::generate() }
    }

    /// Restore a keypair from a hex-encoded 32-byte Ed25519 seed.
    ///
    /// @param privateKeyHex - 64 hex characters representing the 32-byte seed.
    /// @returns The restored `KeyPair`.
    /// @throws If the hex string is invalid or not exactly 32 bytes.
    #[napi(factory)]
    pub fn from_hex(private_key_hex: String) -> Result<Self> {
        let bytes = hex::decode(&private_key_hex)
            .map_err(|e| Error::from_reason(format!("Invalid hex: {}", e)))?;
        let inner = OwlKeyPair::from_bytes(&bytes)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(KeyPair { inner })
    }

    /// Get the public key for this keypair.
    ///
    /// @returns The corresponding `PublicKey`.
    #[napi]
    pub fn public_key(&self) -> PublicKey {
        PublicKey { inner: self.inner.public_key() }
    }

    /// Get the hex-encoded 32-byte private key seed.
    ///
    /// @returns 64 hex characters. Store securely — this is the secret key material.
    #[napi]
    pub fn to_hex(&self) -> String {
        hex::encode(self.inner.to_bytes())
    }

    /// Sign a message with this keypair.
    ///
    /// @param message - The message bytes to sign.
    /// @returns An Ed25519 `Signature` (64 bytes).
    #[napi]
    pub fn sign(&self, message: Buffer) -> Signature {
        Signature { inner: self.inner.sign(message.as_ref()) }
    }
}

// ============================================================================
// CRYPTO — PublicKey
// ============================================================================

/// An Ed25519 public key for signature verification.
#[napi]
pub struct PublicKey {
    inner: OwlPublicKey,
}

#[napi]
impl PublicKey {
    /// Create a public key from a 64-character hex string.
    ///
    /// @param hex - 64 hex characters (32 bytes).
    /// @throws If the hex is invalid or the wrong length.
    #[napi(factory)]
    pub fn from_hex(hex: String) -> Result<Self> {
        let inner = OwlPublicKey::from_hex(&hex)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(PublicKey { inner })
    }

    /// Convert to a 64-character hex string.
    ///
    /// @returns 64 hex characters. Use this value for `ProofRequest.trustedIssuers`.
    #[napi]
    pub fn to_hex(&self) -> String {
        self.inner.to_hex()
    }

    /// Verify an Ed25519 signature on a message.
    ///
    /// Returns `false` for invalid signatures instead of throwing.
    ///
    /// @param message - The original message bytes.
    /// @param signature - The signature to verify.
    /// @returns `true` if the signature is valid, `false` otherwise.
    #[napi]
    pub fn verify(&self, message: Buffer, signature: &Signature) -> Result<bool> {
        Ok(self.inner.verify(message.as_ref(), &signature.inner).is_ok())
    }
}

// ============================================================================
// CRYPTO — Signature
// ============================================================================

/// An Ed25519 signature (64 bytes).
#[napi]
pub struct Signature {
    inner: OwlSignature,
}

#[napi]
impl Signature {
    /// Create a signature from a 128-character hex string (64 bytes).
    ///
    /// @param hex - 128 hex characters.
    /// @throws If the hex is invalid or the wrong length.
    #[napi(factory)]
    pub fn from_hex(hex: String) -> Result<Self> {
        let inner = OwlSignature::from_hex(&hex)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Signature { inner })
    }

    /// Convert to a 128-character hex string.
    ///
    /// @returns 128 hex characters (64 bytes).
    #[napi]
    pub fn to_hex(&self) -> String {
        self.inner.to_hex()
    }
}

// ============================================================================
// HASH FUNCTIONS
// ============================================================================

/// Hash data with SHA-256.
///
/// @param data - The bytes to hash.
/// @returns 64 hex characters (256-bit digest).
#[napi]
pub fn sha256(data: Buffer) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(data.as_ref()))
}

/// Hash data with BLAKE3 (faster than SHA-256, equally secure).
///
/// @param data - The bytes to hash.
/// @returns 64 hex characters (256-bit digest).
#[napi(js_name = "blake3")]
pub fn blake3_hash(data: Buffer) -> String {
    blake3::hash(data.as_ref()).to_hex().to_string()
}

// ============================================================================
// CREDENTIAL — Document
// ============================================================================

/// An unsigned document containing identity attributes.
///
/// Create a `Document` from a JSON object of attributes, then call `.issue()`
/// with an issuer keypair to produce a signed `Credential`.
///
/// @example
/// ```js
/// const doc = Document.fromJson(JSON.stringify({
///   issuerKey: issuerKp.publicKey().toHex(),
///   ownerKey: ownerKp.publicKey().toHex(),
///   name: 'Alice Johnson',
///   dateOfBirth: '1999-01-15',
/// }))
/// const proofDoc = doc.issue(issuerKeyPair)
/// ```
#[napi]
pub struct Document {
    inner: OwlDocument,
}

#[napi]
impl Document {
    /// Create a document from a JSON string of attributes.
    ///
    /// The JSON must be a flat object with string keys and JSON-compatible values.
    /// Must include `issuerKey` and `ownerKey` (hex public keys).
    ///
    /// @param attributesJson - A `JSON.stringify()`'d object of attributes.
    /// @returns A new unsigned `Document`.
    /// @throws If the string is not valid JSON or not an object.
    #[napi(factory)]
    pub fn from_json(attributes_json: String) -> Result<Self> {
        let value: serde_json::Value = serde_json::from_str(&attributes_json)
            .map_err(|e| Error::from_reason(format!("Invalid JSON: {}", e)))?;
        let attrs = value.as_object()
            .ok_or_else(|| Error::from_reason("attributes must be a JSON object"))?
            .clone();
        let doc = OwlDocument::new(attrs.into_iter().collect())
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Document { inner: doc })
    }

    /// Issue the document by signing it with an issuer keypair.
    ///
    /// Builds a Merkle tree over the attributes and signs the root.
    ///
    /// @param issuerKeypair - The issuer's `KeyPair` used to sign.
    /// @returns A signed `Credential` ready for proof generation.
    #[napi]
    pub fn issue(&self, issuer_keypair: &KeyPair) -> Credential {
        Credential { inner: self.inner.clone().issue(&issuer_keypair.inner) }
    }
}

// ============================================================================
// CREDENTIAL — Credential (signed, issued)
// ============================================================================

/// A signed, issued credential containing a Merkle tree of attributes.
///
/// Use `generateProof()` for Ed25519-signed tokens, or `prepareToken()`
/// followed by `Token.finalizeWebauthn()` / `Token.finalizeRingSig()`
/// for WebAuthn or ring-signature flows.
#[napi]
pub struct Credential {
    inner: OwlProofDocument,
}

#[napi]
impl Credential {
    /// Generate a proof token signed with Ed25519.
    ///
    /// Performs selective disclosure (Merkle proofs) and/or ZK predicate proofs
    /// as specified in the request, then signs the result with the owner's keypair.
    ///
    /// @param request - What to prove: disclosed attributes, predicates, trusted issuers, and challenge.
    /// @param keypair - The credential owner's `KeyPair` for signing.
    /// @param ttlSeconds - Token time-to-live in seconds (e.g., `3600` for 1 hour).
    /// @returns A signed `Token` ready for verification or compact encoding.
    /// @throws If a requested attribute doesn't exist or a predicate is invalid.
    #[napi]
    pub fn prove(
        &mut self,
        request: ProofRequest,
        keypair: &KeyPair,
        ttl_seconds: i64,
    ) -> Result<Token> {
        let owl_req = convert_proof_request(&request)?;
        let token = OwlToken::generate(&mut self.inner, &owl_req, &keypair.inner, ttl_seconds)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Token { inner: token })
    }

    /// Prepare a token for two-phase signing (WebAuthn or ring signature).
    ///
    /// Phase 1: Call this to build the token payload without a signature.
    /// Phase 2: Use `Token.finalizeWebauthn()` or `Token.finalizeRingSig()`
    /// to attach the signature.
    ///
    /// @param request - What to prove (same as `generateProof`).
    /// @param ttlSeconds - Token time-to-live in seconds.
    /// @returns A `PreparedToken` containing the challenge to sign.
    /// @throws If a requested attribute doesn't exist or a predicate is invalid.
    #[napi]
    pub fn prepare(
        &mut self,
        request: ProofRequest,
        ttl_seconds: i64,
    ) -> Result<PreparedToken> {
        let owl_req = convert_proof_request(&request)?;
        let prepared = OwlToken::prepare(&mut self.inner, &owl_req, ttl_seconds)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(PreparedToken { inner: prepared })
    }

    /// Get the Merkle root hash of this credential's attributes.
    ///
    /// This is the unique fingerprint of the credential content. Used as the
    /// credential identifier for revocation.
    ///
    /// @returns 64 hex characters (SHA-256 Merkle root).
    #[napi]
    pub fn root_hash(&self) -> String {
        self.inner.root_hash().to_string()
    }

    /// Serialize to a JSON string for storage.
    ///
    /// @returns JSON string that can be restored with `Credential.fromJson()`.
    #[napi]
    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string(&self.inner).map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Restore a `Credential` from a JSON string.
    ///
    /// @param json - JSON previously obtained from `proofDocument.toJson()`.
    /// @throws If the JSON is invalid or malformed.
    #[napi(factory)]
    pub fn from_json(json: String) -> Result<Self> {
        let inner: OwlProofDocument = serde_json::from_str(&json)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Credential { inner })
    }
}

// ============================================================================
// PROOF REQUEST
// ============================================================================

/// Specifies what to prove in a proof token.
///
/// @example
/// ```js
/// const request = {
///   disclose: ['name', 'nationality'],
///   predicates: [{
///     attribute: 'dateOfBirth',
///     op: 'GreaterOrEqual',
///     value: '18',
///   }],
///   trustedIssuers: [issuerPk.toHex()],
///   challenge: serverChallenge,
/// }
/// ```
#[napi(object)]
pub struct ProofRequest {
    /// Attribute names to reveal as plaintext via Merkle selective disclosure.
    pub disclose: Vec<String>,
    /// ZK predicate proofs — prove facts about attributes without revealing values.
    pub predicates: Vec<PredicateRequest>,
    /// Trusted issuer public keys as hex strings.
    pub trusted_issuers: Vec<String>,
    /// Random challenge string for replay prevention (hex from server).
    pub challenge: String,
}

/// A predicate to prove in zero knowledge.
///
/// Supported operators:
/// - `"GreaterOrEqual"` — proves the attribute value >= threshold.
///   For `dateOfBirth`, the value is an age (e.g., `"18"`).
/// - `"InSet"` — proves the attribute value is in a set.
///   The value is a JSON array (e.g., `JSON.stringify(["NL", "DE", "FR"])`).
#[napi(object)]
pub struct PredicateRequest {
    /// Credential attribute name (e.g., `"dateOfBirth"`, `"nationality"`).
    pub attribute: String,
    /// Predicate operator: `"GreaterOrEqual"` or `"InSet"`.
    pub op: String,
    /// JSON-encoded threshold or target value.
    pub value: String,
}

// ============================================================================
// TOKEN
// ============================================================================

/// A verifiable proof token for presentation to verifiers.
///
/// Contains selective disclosure proofs, optional ZK predicate proofs,
/// and a cryptographic signature (Ed25519, WebAuthn P-256, or ring signature).
///
/// Supports two serialization formats:
/// - **Compact** (`OID1:...`): optimized for QR codes, uses CBOR + zstd + Base45.
/// - **JSON**: full fidelity, for storage and debugging.
#[napi]
pub struct Token {
    inner: OwlToken,
}

#[napi]
impl Token {
    // -- Serialization --------------------------------------------------------

    /// Encode to compact format for QR codes and size-constrained transports.
    ///
    /// Pipeline: Token → CBOR → zstd(dict) → Base45 → `OID1:` prefix.
    /// Typical sizes: ~500-1000 chars for selective disclosure,
    /// ~1000-1500 chars with ZK proofs.
    ///
    /// @returns A compact string starting with `OID1:`.
    /// @throws If encoding fails.
    #[napi]
    pub fn to_compact(&self) -> Result<String> {
        self.inner.to_compact().map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Decode a token from compact format.
    ///
    /// @param compact - A compact string starting with `OID1:`.
    /// @throws If the input is malformed, corrupted, or uses an unsupported version.
    #[napi(factory)]
    pub fn from_compact(compact: String) -> Result<Self> {
        let inner = OwlToken::from_compact(&compact)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Token { inner })
    }

    /// Serialize the token to a JSON string.
    ///
    /// @returns JSON string that can be restored with `Token.fromJson()`.
    #[napi]
    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string(&self.inner).map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Restore a `Token` from a JSON string.
    ///
    /// @param json - JSON previously obtained from `token.toJson()`.
    /// @throws If the JSON is invalid or malformed.
    #[napi(factory)]
    pub fn from_json(json: String) -> Result<Self> {
        let inner: OwlToken = serde_json::from_str(&json)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Token { inner })
    }

    // -- Accessors ------------------------------------------------------------

    /// Get disclosed attributes as a JSON string.
    ///
    /// @returns JSON object string. Parse with `JSON.parse()`.
    #[napi]
    pub fn subjects(&self) -> Result<String> {
        serde_json::to_string(self.inner.subjects())
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Get the challenge this token is bound to.
    ///
    /// @returns The challenge string from the original proof request.
    #[napi]
    pub fn challenge(&self) -> String {
        self.inner.payload().challenge.clone()
    }

    /// Get the credential root hash (hex).
    ///
    /// This is the credential identifier — use it for revocation checks.
    ///
    /// @returns 64 hex characters (SHA-256 Merkle root).
    #[napi]
    pub fn root_hash(&self) -> String {
        self.inner.payload().root_hash.clone()
    }

    /// Get the number of ZK proofs attached to this token.
    #[napi]
    pub fn zk_proof_count(&self) -> u32 {
        self.inner.zk_proofs().len() as u32
    }

    /// Get the token's time-to-live in seconds.
    #[napi]
    pub fn ttl(&self) -> i64 {
        self.inner.payload().ttl
    }

    /// Get activation time as unix epoch seconds.
    #[napi]
    pub fn activation_time(&self) -> i64 {
        self.inner.payload().activation_time
    }

    // -- Verification ---------------------------------------------------------

    /// Verify the token's proofs, signature, expiration, and issuer trust.
    ///
    /// Checks: (1) Merkle proofs are valid, (2) ZK predicate proofs are valid,
    /// (3) signature is valid, (4) token is not expired, (5) issuer is trusted,
    /// (6) credential is not revoked.
    ///
    /// @param trustedIssuers - Array of trusted issuer `PublicKey` objects.
    /// @param challenge - The challenge string used when generating the proof.
    /// @param revokedHashes - Optional array of revoked credential root hashes (hex).
    /// @returns JSON string of disclosed attributes. Parse with `JSON.parse()`.
    /// @throws If any verification check fails.
    ///
    /// @example
    /// ```js
    /// const json = token.verify([issuerPk], challenge)
    /// const disclosed = JSON.parse(json)
    /// console.log(disclosed.name) // 'Alice'
    /// ```
    #[napi]
    pub fn verify(
        &self,
        trusted_issuers: Vec<&PublicKey>,
        challenge: String,
        revoked_hashes: Option<Vec<String>>,
    ) -> Result<String> {
        let issuers: Vec<OwlPublicKey> =
            trusted_issuers.iter().map(|pk| pk.inner.clone()).collect();

        let registry = RevocationRegistry::new();
        if let Some(hashes) = revoked_hashes {
            for hash in hashes {
                registry.revoke(hash, String::new(), Some("Revoked via SDK".into()));
            }
        }

        self.inner.verify(&issuers, &challenge, &registry)
            .map_err(|e| Error::from_reason(e.to_string()))?;

        serde_json::to_string(self.inner.subjects())
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    // -- Two-phase signing (finalize) -----------------------------------------

    /// Finalize a prepared token with a WebAuthn (FIDO2) signature.
    ///
    /// Completes the two-phase signing flow started by `credential.prepare()`.
    /// Use the challenge from `preparedToken.challenge()` as the WebAuthn assertion challenge.
    ///
    /// @param prepared - The `PreparedToken` from `credential.prepare()`.
    /// @param webauthnSig - The `WebAuthnSignatureData` from `navigator.credentials.get()`.
    /// @param credentialPublicKey - Hex-encoded P-256 public key from WebAuthn registration.
    /// @returns A finalized `Token` with a WebAuthn P-256 signature.
    /// @throws If the signature data is invalid.
    #[napi]
    pub fn finalize_webauthn(
        prepared: &PreparedToken,
        webauthn_sig: WebAuthnSignatureData,
        credential_public_key: String,
    ) -> Result<Token> {
        let token = OwlToken::finalize_webauthn(
            prepared.inner.clone(),
            webauthn_sig.authenticator_data,
            webauthn_sig.client_data_json,
            webauthn_sig.signature,
            credential_public_key,
        ).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Token { inner: token })
    }

    /// Finalize a prepared token with a ring signature for anonymous owner authentication.
    ///
    /// Creates a proof that the signer is one of the ring members without revealing
    /// which specific member signed.
    ///
    /// @param prepared - The `PreparedToken` from `credential.prepare()`.
    /// @param privateKeyHex - Hex-encoded 32-byte private key of the signer.
    /// @param ringPublicKeysHex - Array of hex-encoded 32-byte public keys forming
    ///   the anonymity set. Must include the signer's public key.
    /// @returns A finalized `Token` with a ring signature.
    /// @throws If any hex key is invalid or the signer's key is not in the ring.
    #[napi]
    pub fn finalize_ring_sig(
        prepared: &PreparedToken,
        private_key_hex: String,
        ring_public_keys_hex: Vec<String>,
    ) -> Result<Token> {
        let sk = hex::decode(&private_key_hex)
            .map_err(|e| Error::from_reason(format!("Invalid private key hex: {}", e)))?;
        let sk: [u8; 32] = sk.try_into()
            .map_err(|_| Error::from_reason("Private key must be 32 bytes"))?;

        let ring: Vec<[u8; 32]> = ring_public_keys_hex.iter()
            .map(|h| {
                let b = hex::decode(h)
                    .map_err(|e| Error::from_reason(format!("Invalid ring key hex: {}", e)))?;
                b.try_into()
                    .map_err(|_| Error::from_reason("Ring public key must be 32 bytes"))
            })
            .collect::<Result<_>>()?;

        let token = OwlToken::finalize_ring_sig(prepared.inner.clone(), &sk, &ring)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Token { inner: token })
    }
}

// ============================================================================
// WEBAUTHN
// ============================================================================

/// WebAuthn signature data from `navigator.credentials.get()`.
///
/// All fields are Base64-encoded byte arrays from the WebAuthn assertion response.
#[napi(object)]
pub struct WebAuthnSignatureData {
    /// Base64-encoded authenticator data.
    pub authenticator_data: String,
    /// Base64-encoded client data JSON.
    pub client_data_json: String,
    /// Base64-encoded ECDSA P-256 signature.
    pub signature: String,
}

// ============================================================================
// PREPARED TOKEN
// ============================================================================

/// A prepared token awaiting a signature (WebAuthn or ring signature).
///
/// Created by `credential.prepare()`. Contains the unsigned token payload
/// and the challenge to present to the signing mechanism.
#[napi]
pub struct PreparedToken {
    inner: OwlPreparedToken,
}

#[napi]
impl PreparedToken {
    /// Get the challenge for signing (base64url-encoded SHA-256 of the payload).
    ///
    /// Pass this as the WebAuthn assertion challenge.
    ///
    /// @returns Base64url-encoded challenge string.
    #[napi]
    pub fn challenge(&self) -> String {
        self.inner.challenge().to_string()
    }

    /// Get the serialized payload as a JSON string (for debugging/inspection).
    ///
    /// @returns JSON string of the unsigned token payload.
    #[napi]
    pub fn payload_json(&self) -> String {
        self.inner.payload_json().to_string()
    }

    /// Serialize to JSON for storage or cross-context transfer.
    ///
    /// @returns JSON string that can be restored with `PreparedToken.fromJson()`.
    #[napi]
    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string(&self.inner).map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Restore a `PreparedToken` from a JSON string.
    ///
    /// @param json - JSON previously obtained from `preparedToken.toJson()`.
    /// @throws If the JSON is invalid or malformed.
    #[napi(factory)]
    pub fn from_json(json: String) -> Result<Self> {
        let inner: OwlPreparedToken = serde_json::from_str(&json)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(PreparedToken { inner })
    }
}

// ============================================================================
// INTERNAL
// ============================================================================

fn convert_proof_request(req: &ProofRequest) -> napi::Result<OwlProofRequest> {
    let predicates = req.predicates.iter()
        .map(|p| {
            let op = match p.op.as_str() {
                "GreaterOrEqual" => Ok(OwlPredicateOp::GreaterOrEqual),
                "InSet" => Ok(OwlPredicateOp::InSet),
                other => Err(Error::from_reason(format!("Unknown predicate op: {}", other))),
            }?;
            let value: serde_json::Value = serde_json::from_str(&p.value)
                .map_err(|e| Error::from_reason(format!("Invalid predicate value JSON: {}", e)))?;
            Ok(OwlPredicateRequest { attribute: p.attribute.clone(), op, value })
        })
        .collect::<napi::Result<Vec<_>>>()?;

    Ok(OwlProofRequest {
        disclose: req.disclose.clone(),
        predicates,
        trusted_issuers: req.trusted_issuers.clone(),
        challenge: req.challenge.clone(),
    })
}
