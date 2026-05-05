//! Mock Identity Provider implementations
//!
//! This module provides mock identity providers for testing and development.
//! They simulate government eID systems like DigiD (Netherlands) and
//! BankID (Sweden/Norway).

use crate::database::IdpDatabase;
use crate::error::{IdpError, Result};
use crate::models::{
    IdentitySubmissionForm, ProviderInfo, SessionStatus, VerificationLevel, VerificationSession,
    VerifiedIdentityClaims,
};
use crate::normalizer::{MockClaims, RawProviderClaims};
use crate::provider::{
    DigitalIdentityProvider, FormConfig, ProviderFlowType, VerificationStart,
};
use async_trait::async_trait;
use chrono::Utc;
use std::sync::Arc;
use uuid::Uuid;

/// Mock DigiD-like Identity Provider
///
/// This simulates the verification flow of a government eID system:
/// 1. User starts a verification session
/// 2. User submits identity data (simulating document scan/bank login)
/// 3. IdP "verifies" the data (simulated for PoC)
/// 4. IdP returns verified claims with derived attributes
pub struct MockDigiDProvider {
    db: Arc<IdpDatabase>,
    provider_id: String,
    name: String,
}

impl MockDigiDProvider {
    /// Create a new Mock DigiD provider
    pub fn new(db: Arc<IdpDatabase>) -> Self {
        Self {
            db,
            provider_id: "mock-digid".to_string(),
            name: "Mock DigiD (Netherlands)".to_string(),
        }
    }

    /// Validate the submission form
    fn validate_form(&self, form: &IdentitySubmissionForm) -> Result<()> {
        if form.first_name.trim().is_empty() {
            return Err(IdpError::MissingField("first_name".to_string()));
        }
        if form.last_name.trim().is_empty() {
            return Err(IdpError::MissingField("last_name".to_string()));
        }
        if form.national_id.trim().is_empty() {
            return Err(IdpError::MissingField("national_id".to_string()));
        }

        // Validate date of birth is in the past
        let today = Utc::now().date_naive();
        if form.date_of_birth >= today {
            return Err(IdpError::InvalidField {
                field: "date_of_birth".to_string(),
                reason: "Date of birth must be in the past".to_string(),
            });
        }

        Ok(())
    }

    /// Convert submission form to mock claims
    fn form_to_raw_claims(&self, form: IdentitySubmissionForm) -> RawProviderClaims {
        let dob = form.date_of_birth;

        RawProviderClaims::Mock(MockClaims {
            provider_id: self.provider_id.clone(),
            first_name: form.first_name,
            last_name: form.last_name,
            date_of_birth: dob,
            place_of_birth: form.place_of_birth,
            nationality: form.nationality.clone(),
            national_id: form.national_id,
            street_address: form.street_address,
            city: form.city,
            postal_code: form.postal_code,
            country: form.country.clone(),
            gender: form.gender,
            passport_number: form.passport_number,
            drivers_license: form.drivers_license,
            tax_id: form.tax_id,
            verification_level: VerificationLevel::Substantial,
            verification_method: "simulated".to_string(),
            verifies_residency: form.country.eq_ignore_ascii_case("Netherlands")
                || form.country.eq_ignore_ascii_case("NL"),
        })
    }

    /// Legacy method: Submit identity and verify
    pub async fn submit_identity(
        &self,
        session_id: Uuid,
        form: IdentitySubmissionForm,
    ) -> Result<VerifiedIdentityClaims> {
        // Get session and validate state
        let session = self
            .db
            .get_session(session_id)
            .await?
            .ok_or_else(|| IdpError::SessionNotFound(session_id.to_string()))?;

        if session.is_expired() {
            self.db
                .update_session_status(session_id, SessionStatus::Expired)
                .await?;
            return Err(IdpError::SessionExpired);
        }

        if session.status != SessionStatus::Pending {
            return Err(IdpError::InvalidSessionState {
                expected: "pending".to_string(),
                actual: session.status.as_str().to_string(),
            });
        }

        // Validate form
        self.validate_form(&form)?;

        // Convert to JSON for form submission handler
        let form_data = serde_json::to_value(&form)
            .map_err(|e| IdpError::Serialization(e.to_string()))?;

        // Use the trait method
        let raw_claims = self.handle_form_submission(session_id, form_data).await?;
        Ok(raw_claims.normalize())
    }

    /// Legacy method: Get verified claims
    pub async fn get_claims(&self, session_id: Uuid) -> Result<VerifiedIdentityClaims> {
        let session = self
            .db
            .get_session(session_id)
            .await?
            .ok_or_else(|| IdpError::SessionNotFound(session_id.to_string()))?;

        if session.status != SessionStatus::Verified {
            return Err(IdpError::InvalidSessionState {
                expected: "verified".to_string(),
                actual: session.status.as_str().to_string(),
            });
        }

        self.db
            .get_claims(session_id)
            .await?
            .ok_or_else(|| IdpError::Internal("Claims not found for verified session".to_string()))
    }

    /// Legacy method: Get session
    pub async fn get_session(&self, session_id: Uuid) -> Result<VerificationSession> {
        let session = self
            .db
            .get_session(session_id)
            .await?
            .ok_or_else(|| IdpError::SessionNotFound(session_id.to_string()))?;

        if session.is_expired() {
            self.db
                .update_session_status(session_id, SessionStatus::Expired)
                .await?;
            return Err(IdpError::SessionExpired);
        }

        Ok(session)
    }

    /// Legacy method: Start verification
    pub async fn start_verification(&self) -> Result<VerificationSession> {
        self.db
            .create_session_with_flow(&self.provider_id, ProviderFlowType::FormBased)
            .await
    }
}

#[async_trait]
impl DigitalIdentityProvider for MockDigiDProvider {
    fn provider_id(&self) -> &str {
        &self.provider_id
    }

    fn provider_type(&self) -> ProviderFlowType {
        ProviderFlowType::FormBased
    }

    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            id: self.provider_id.clone(),
            name: self.name.clone(),
            description: "Simulated Dutch government eID provider (DigiD-like)".to_string(),
            verification_levels: vec![VerificationLevel::Substantial, VerificationLevel::High],
            country: "Netherlands".to_string(),
        }
    }

    fn verification_level(&self) -> VerificationLevel {
        VerificationLevel::Substantial
    }

    async fn start_verification(&self, session_id: Uuid) -> Result<VerificationStart> {
        // Update session to pending state (it should already exist)
        self.db
            .update_session_status(session_id, SessionStatus::Pending)
            .await?;

        Ok(VerificationStart::Form {
            config: FormConfig {
                instructions: Some(
                    "Enter your identity details as they appear on your Dutch ID card or passport."
                        .to_string(),
                ),
                ..Default::default()
            },
        })
    }

    async fn handle_form_submission(
        &self,
        session_id: Uuid,
        form_data: serde_json::Value,
    ) -> Result<RawProviderClaims> {
        // Parse form data
        let form: IdentitySubmissionForm = serde_json::from_value(form_data)
            .map_err(|e| IdpError::Serialization(e.to_string()))?;

        // Update status to verifying
        self.db
            .update_session_status(session_id, SessionStatus::Verifying)
            .await?;

        // Simulate verification delay
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        // Validate form
        self.validate_form(&form)?;

        // Convert to raw claims
        let raw_claims = self.form_to_raw_claims(form);

        // Normalize and store
        let claims = raw_claims.normalize();
        self.db.store_claims(session_id, &claims).await?;

        // Mark as verified
        let raw_json = serde_json::to_value(&raw_claims)
            .map_err(|e| IdpError::Serialization(e.to_string()))?;
        self.db
            .mark_session_verified(session_id, Some(raw_json))
            .await?;

        Ok(raw_claims)
    }
}

/// Mock BankID-like Identity Provider
pub struct MockBankIdProvider {
    db: Arc<IdpDatabase>,
    provider_id: String,
    name: String,
}

impl MockBankIdProvider {
    /// Create a new Mock BankID provider
    pub fn new(db: Arc<IdpDatabase>) -> Self {
        Self {
            db,
            provider_id: "mock-bankid".to_string(),
            name: "Mock BankID (Sweden)".to_string(),
        }
    }

    /// Convert submission form to mock claims
    fn form_to_raw_claims(&self, form: IdentitySubmissionForm) -> RawProviderClaims {
        let dob = form.date_of_birth;

        RawProviderClaims::Mock(MockClaims {
            provider_id: self.provider_id.clone(),
            first_name: form.first_name,
            last_name: form.last_name,
            date_of_birth: dob,
            place_of_birth: form.place_of_birth,
            nationality: form.nationality.clone(),
            national_id: form.national_id,
            street_address: form.street_address,
            city: form.city,
            postal_code: form.postal_code,
            country: form.country.clone(),
            gender: form.gender,
            passport_number: form.passport_number,
            drivers_license: form.drivers_license,
            tax_id: form.tax_id,
            verification_level: VerificationLevel::High, // Bank verification is high assurance
            verification_method: "bank_login".to_string(),
            verifies_residency: form.country.eq_ignore_ascii_case("Sweden")
                || form.country.eq_ignore_ascii_case("SE"),
        })
    }

    /// Legacy method: Submit identity and verify
    pub async fn submit_identity(
        &self,
        session_id: Uuid,
        form: IdentitySubmissionForm,
    ) -> Result<VerifiedIdentityClaims> {
        let session = self
            .db
            .get_session(session_id)
            .await?
            .ok_or_else(|| IdpError::SessionNotFound(session_id.to_string()))?;

        if session.is_expired() {
            return Err(IdpError::SessionExpired);
        }

        if session.status != SessionStatus::Pending {
            return Err(IdpError::InvalidSessionState {
                expected: "pending".to_string(),
                actual: session.status.as_str().to_string(),
            });
        }

        let form_data = serde_json::to_value(&form)
            .map_err(|e| IdpError::Serialization(e.to_string()))?;

        let raw_claims = self.handle_form_submission(session_id, form_data).await?;
        Ok(raw_claims.normalize())
    }

    /// Legacy method: Get verified claims
    pub async fn get_claims(&self, session_id: Uuid) -> Result<VerifiedIdentityClaims> {
        let session = self
            .db
            .get_session(session_id)
            .await?
            .ok_or_else(|| IdpError::SessionNotFound(session_id.to_string()))?;

        if session.status != SessionStatus::Verified {
            return Err(IdpError::InvalidSessionState {
                expected: "verified".to_string(),
                actual: session.status.as_str().to_string(),
            });
        }

        self.db
            .get_claims(session_id)
            .await?
            .ok_or_else(|| IdpError::Internal("Claims not found".to_string()))
    }

    /// Legacy method: Start verification
    pub async fn start_verification(&self) -> Result<VerificationSession> {
        self.db
            .create_session_with_flow(&self.provider_id, ProviderFlowType::FormBased)
            .await
    }
}

#[async_trait]
impl DigitalIdentityProvider for MockBankIdProvider {
    fn provider_id(&self) -> &str {
        &self.provider_id
    }

    fn provider_type(&self) -> ProviderFlowType {
        ProviderFlowType::FormBased
    }

    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            id: self.provider_id.clone(),
            name: self.name.clone(),
            description: "Simulated Swedish bank identity provider (BankID-like)".to_string(),
            verification_levels: vec![VerificationLevel::High],
            country: "Sweden".to_string(),
        }
    }

    fn verification_level(&self) -> VerificationLevel {
        VerificationLevel::High
    }

    async fn start_verification(&self, session_id: Uuid) -> Result<VerificationStart> {
        self.db
            .update_session_status(session_id, SessionStatus::Pending)
            .await?;

        Ok(VerificationStart::Form {
            config: FormConfig {
                instructions: Some(
                    "Enter your identity details as they appear in your Swedish bank records."
                        .to_string(),
                ),
                ..Default::default()
            },
        })
    }

    async fn handle_form_submission(
        &self,
        session_id: Uuid,
        form_data: serde_json::Value,
    ) -> Result<RawProviderClaims> {
        let form: IdentitySubmissionForm = serde_json::from_value(form_data)
            .map_err(|e| IdpError::Serialization(e.to_string()))?;

        // Simulate bank verification delay
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        let raw_claims = self.form_to_raw_claims(form);
        let claims = raw_claims.normalize();

        self.db.store_claims(session_id, &claims).await?;

        let raw_json = serde_json::to_value(&raw_claims)
            .map_err(|e| IdpError::Serialization(e.to_string()))?;
        self.db
            .mark_session_verified(session_id, Some(raw_json))
            .await?;

        Ok(raw_claims)
    }
}

/// Enum-based provider to avoid dyn trait compatibility issues with async
pub enum MockProvider {
    DigiD(MockDigiDProvider),
    BankId(MockBankIdProvider),
}

impl MockProvider {
    pub fn info(&self) -> ProviderInfo {
        match self {
            Self::DigiD(p) => <MockDigiDProvider as DigitalIdentityProvider>::info(p),
            Self::BankId(p) => <MockBankIdProvider as DigitalIdentityProvider>::info(p),
        }
    }

    pub fn provider_type(&self) -> ProviderFlowType {
        match self {
            Self::DigiD(p) => p.provider_type(),
            Self::BankId(p) => p.provider_type(),
        }
    }

    pub async fn start_verification(&self) -> Result<VerificationSession> {
        match self {
            Self::DigiD(p) => p.start_verification().await,
            Self::BankId(p) => p.start_verification().await,
        }
    }

    pub async fn submit_identity(
        &self,
        session_id: Uuid,
        form: IdentitySubmissionForm,
    ) -> Result<VerifiedIdentityClaims> {
        match self {
            Self::DigiD(p) => p.submit_identity(session_id, form).await,
            Self::BankId(p) => p.submit_identity(session_id, form).await,
        }
    }

    pub async fn get_claims(&self, session_id: Uuid) -> Result<VerifiedIdentityClaims> {
        match self {
            Self::DigiD(p) => p.get_claims(session_id).await,
            Self::BankId(p) => p.get_claims(session_id).await,
        }
    }
}

/// Factory for creating mock providers
pub struct MockProviderFactory {
    db: Arc<IdpDatabase>,
}

impl MockProviderFactory {
    pub fn new(db: Arc<IdpDatabase>) -> Self {
        Self { db }
    }

    /// List all available providers
    pub fn list_providers(&self) -> Vec<ProviderInfo> {
        vec![
            <MockDigiDProvider as DigitalIdentityProvider>::info(&MockDigiDProvider::new(
                self.db.clone(),
            )),
            <MockBankIdProvider as DigitalIdentityProvider>::info(&MockBankIdProvider::new(
                self.db.clone(),
            )),
        ]
    }

    /// Get a provider by ID
    pub fn get_provider(&self, provider_id: &str) -> Option<MockProvider> {
        match provider_id {
            "mock-digid" => Some(MockProvider::DigiD(MockDigiDProvider::new(self.db.clone()))),
            "mock-bankid" => Some(MockProvider::BankId(MockBankIdProvider::new(self.db.clone()))),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    #[tokio::test]
    async fn test_digid_verification_flow() {
        let db = Arc::new(IdpDatabase::new());
        let provider = MockDigiDProvider::new(db);

        // Start session
        let session = provider.start_verification().await.unwrap();
        assert_eq!(session.status, SessionStatus::Pending);

        // Submit identity
        let form = IdentitySubmissionForm {
            first_name: "Jan".to_string(),
            last_name: "de Vries".to_string(),
            date_of_birth: NaiveDate::from_ymd_opt(1985, 3, 15).unwrap(),
            place_of_birth: "Amsterdam".to_string(),
            nationality: "Dutch".to_string(),
            national_id: "123456789".to_string(),
            street_address: "Kerkstraat 1".to_string(),
            city: "Amsterdam".to_string(),
            postal_code: "1012 AB".to_string(),
            country: "Netherlands".to_string(),
            gender: None,
            passport_number: None,
            drivers_license: None,
            tax_id: None,
        };

        let claims = provider.submit_identity(session.id, form).await.unwrap();

        // Verify claims
        assert_eq!(claims.first_name, "Jan");
        assert!(claims.is_over_18);
        assert!(claims.is_over_21);
        assert!(!claims.is_over_65);
        assert!(claims.is_eu_citizen);
        assert_eq!(claims.verification_level, VerificationLevel::Substantial);

        // Get claims again
        let retrieved = provider.get_claims(session.id).await.unwrap();
        assert_eq!(retrieved.first_name, "Jan");
    }

    #[tokio::test]
    async fn test_young_person_age_verification() {
        let db = Arc::new(IdpDatabase::new());
        let provider = MockDigiDProvider::new(db);

        let session = provider.start_verification().await.unwrap();

        // Create a 19-year-old
        let today = Utc::now().date_naive();
        let dob = today - chrono::Duration::days(19 * 365 + 5);

        let form = IdentitySubmissionForm {
            first_name: "Young".to_string(),
            last_name: "Person".to_string(),
            date_of_birth: dob,
            place_of_birth: "Rotterdam".to_string(),
            nationality: "Dutch".to_string(),
            national_id: "987654321".to_string(),
            street_address: "Test Street 1".to_string(),
            city: "Rotterdam".to_string(),
            postal_code: "3000 AA".to_string(),
            country: "Netherlands".to_string(),
            gender: None,
            passport_number: None,
            drivers_license: None,
            tax_id: None,
        };

        let claims = provider.submit_identity(session.id, form).await.unwrap();

        assert!(claims.is_over_18);
        assert!(!claims.is_over_21); // 19 < 21
    }

    #[tokio::test]
    async fn test_provider_trait_implementation() {
        let db = Arc::new(IdpDatabase::new());
        let provider = MockDigiDProvider::new(db.clone());

        // Test trait methods
        assert_eq!(provider.provider_id(), "mock-digid");
        assert_eq!(provider.provider_type(), ProviderFlowType::FormBased);
        assert_eq!(provider.verification_level(), VerificationLevel::Substantial);

        let info = provider.info();
        assert_eq!(info.id, "mock-digid");
        assert_eq!(info.country, "Netherlands");
    }
}
