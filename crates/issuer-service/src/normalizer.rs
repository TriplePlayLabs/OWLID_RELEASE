//! Claim normalization for different identity providers
//!
//! Different identity providers return claims in different formats.
//! This module normalizes them to a common `VerifiedIdentityClaims` structure.

use crate::models::{is_eu_citizen, is_over_age, VerificationLevel, VerifiedIdentityClaims};
use chrono::{NaiveDate, Utc};
use serde::{Deserialize, Serialize};

/// Raw claims from different identity providers
///
/// Each provider returns data in a different format. This enum
/// captures the raw response before normalization.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "provider", rename_all = "snake_case")]
pub enum RawProviderClaims {
    /// DigiD (Netherlands) SAML claims
    DigiD(DigiDSamlClaims),

    /// BankID (Sweden/Norway) completion data
    BankId(BankIdCompletionData),

    /// Onfido KYC applicant data
    Onfido(OnfidoApplicantData),

    /// Jumio identity verification data
    Jumio(JumioIdentityData),

    /// Stripe Identity verified outputs
    StripeIdentity(StripeVerifiedOutputs),

    /// eIDAS OIDC claims
    Eidas(EidasOidcClaims),

    /// Didit KYC verification data
    Didit(DiditVerificationData),

    /// Mock provider claims (for testing)
    Mock(MockClaims),
}

impl RawProviderClaims {
    /// Normalize raw claims to common VerifiedIdentityClaims format
    pub fn normalize(&self) -> VerifiedIdentityClaims {
        match self {
            Self::DigiD(claims) => normalize_digid(claims),
            Self::BankId(claims) => normalize_bankid(claims),
            Self::Onfido(claims) => normalize_onfido(claims),
            Self::Jumio(claims) => normalize_jumio(claims),
            Self::StripeIdentity(claims) => normalize_stripe(claims),
            Self::Eidas(claims) => normalize_eidas(claims),
            Self::Didit(claims) => normalize_didit(claims),
            Self::Mock(claims) => normalize_mock(claims),
        }
    }

    /// Get the provider ID for these claims
    pub fn provider_id(&self) -> &str {
        match self {
            Self::DigiD(_) => "digid",
            Self::BankId(_) => "bankid",
            Self::Onfido(_) => "onfido",
            Self::Jumio(_) => "jumio",
            Self::StripeIdentity(_) => "stripe-identity",
            Self::Eidas(_) => "eidas",
            Self::Didit(_) => "didit",
            Self::Mock(c) => &c.provider_id,
        }
    }
}

// =============================================================================
// DigiD (Netherlands) Claims
// =============================================================================

/// Claims from DigiD SAML assertion
///
/// DigiD returns minimal data:
/// - Common name (cn)
/// - National ID (BSN - uid)
/// - Date of birth (optional, depending on level)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigiDSamlClaims {
    /// Common name (e.g., "Jan Jansen")
    pub common_name: String,
    /// BSN (Burgerservicenummer) - Dutch national ID
    pub bsn: String,
    /// Date of birth (YYYYMMDD format from SAML)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_of_birth: Option<String>,
    /// Surname (if provided separately)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surname: Option<String>,
    /// Authentication level (betrouwbaarheidsniveau)
    pub auth_level: String,
}

fn normalize_digid(claims: &DigiDSamlClaims) -> VerifiedIdentityClaims {
    // Parse name from common_name
    let name_parts: Vec<&str> = claims.common_name.split_whitespace().collect();
    let (first_name, last_name) = if name_parts.len() >= 2 {
        (
            name_parts[0].to_string(),
            name_parts[1..].join(" "),
        )
    } else {
        (claims.common_name.clone(), String::new())
    };

    // Parse date of birth from YYYYMMDD format
    let date_of_birth = claims
        .date_of_birth
        .as_ref()
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y%m%d").ok())
        .unwrap_or_else(|| NaiveDate::from_ymd_opt(1900, 1, 1).unwrap());

    let verification_level = match claims.auth_level.as_str() {
        "Hoog" | "high" => VerificationLevel::High,
        "Substantieel" | "substantial" => VerificationLevel::Substantial,
        _ => VerificationLevel::Low,
    };

    VerifiedIdentityClaims {
        first_name,
        last_name: claims.surname.clone().unwrap_or(last_name),
        date_of_birth,
        place_of_birth: String::new(), // DigiD doesn't provide this
        nationality: "Dutch".to_string(),
        gender: None,
        national_id: claims.bsn.clone(),
        passport_number: None,
        drivers_license: None,
        tax_id: None,
        document_type: None,
        document_number: None,
        issuing_country: None,
        document_expiry: None,
        document_issue_date: None,
        portrait_image: None,
        street_address: String::new(), // DigiD doesn't provide address
        city: String::new(),
        postal_code: String::new(),
        country: "Netherlands".to_string(),
        is_over_18: is_over_age(date_of_birth, 18),
        is_over_21: is_over_age(date_of_birth, 21),
        is_over_65: is_over_age(date_of_birth, 65),
        is_eu_citizen: true, // Netherlands is EU
        is_resident: true,   // Verified by DigiD means Dutch resident
        verified_at: Utc::now(),
        verification_level,
        provider_id: "digid".to_string(),
        verification_method: "saml_assertion".to_string(),
    }
}

// =============================================================================
// BankID (Sweden/Norway) Claims
// =============================================================================

/// Completion data from BankID
///
/// BankID returns:
/// - Personal number (personnummer)
/// - Full name
/// - Certificate info
/// - Signature
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BankIdCompletionData {
    pub user: BankIdUser,
    /// Base64-encoded signature
    pub signature: String,
    /// Certificate info
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cert: Option<BankIdCert>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BankIdUser {
    /// Personal number (YYYYMMDDXXXX)
    pub personal_number: String,
    /// Full name
    pub name: String,
    /// Given name
    pub given_name: String,
    /// Surname
    pub surname: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BankIdCert {
    pub not_before: String,
    pub not_after: String,
}

fn normalize_bankid(claims: &BankIdCompletionData) -> VerifiedIdentityClaims {
    // Extract date of birth from personal number (YYYYMMDD prefix)
    let dob_str = &claims.user.personal_number[..8];
    let date_of_birth = NaiveDate::parse_from_str(dob_str, "%Y%m%d")
        .unwrap_or_else(|_| NaiveDate::from_ymd_opt(1900, 1, 1).unwrap());

    VerifiedIdentityClaims {
        first_name: claims.user.given_name.clone(),
        last_name: claims.user.surname.clone(),
        date_of_birth,
        place_of_birth: String::new(), // BankID doesn't provide this
        nationality: "Swedish".to_string(),
        gender: None,
        national_id: claims.user.personal_number.clone(),
        passport_number: None,
        drivers_license: None,
        tax_id: None,
        document_type: None,
        document_number: None,
        issuing_country: None,
        document_expiry: None,
        document_issue_date: None,
        portrait_image: None,
        street_address: String::new(), // BankID doesn't provide address
        city: String::new(),
        postal_code: String::new(),
        country: "Sweden".to_string(),
        is_over_18: is_over_age(date_of_birth, 18),
        is_over_21: is_over_age(date_of_birth, 21),
        is_over_65: is_over_age(date_of_birth, 65),
        is_eu_citizen: true, // Sweden is EU
        is_resident: true,   // BankID means Swedish resident
        verified_at: Utc::now(),
        verification_level: VerificationLevel::High, // BankID is high assurance
        provider_id: "bankid".to_string(),
        verification_method: "bank_mobile_app".to_string(),
    }
}

// =============================================================================
// Onfido KYC Claims
// =============================================================================

/// Applicant data from Onfido verification
///
/// Onfido provides full KYC data from document + selfie verification
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OnfidoApplicantData {
    pub first_name: String,
    pub last_name: String,
    pub dob: String, // YYYY-MM-DD format
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<OnfidoAddress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nationality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_number: Option<String>,
    /// Extracted ID numbers from document
    #[serde(default)]
    pub id_numbers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OnfidoAddress {
    pub line1: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line2: Option<String>,
    pub town: String,
    pub postcode: String,
    pub country: String,
}

fn normalize_onfido(claims: &OnfidoApplicantData) -> VerifiedIdentityClaims {
    let date_of_birth = NaiveDate::parse_from_str(&claims.dob, "%Y-%m-%d")
        .unwrap_or_else(|_| NaiveDate::from_ymd_opt(1900, 1, 1).unwrap());

    let nationality = claims.nationality.clone().unwrap_or_default();
    let country = claims
        .address
        .as_ref()
        .map(|a| a.country.clone())
        .unwrap_or_default();

    // Determine if passport based on document type
    let (passport_number, national_id) = match claims.document_type.as_deref() {
        Some("passport") => (claims.document_number.clone(), claims.id_numbers.first().cloned().unwrap_or_default()),
        _ => (None, claims.document_number.clone().or_else(|| claims.id_numbers.first().cloned()).unwrap_or_default()),
    };

    VerifiedIdentityClaims {
        first_name: claims.first_name.clone(),
        last_name: claims.last_name.clone(),
        date_of_birth,
        place_of_birth: String::new(), // Onfido doesn't typically extract this
        nationality: nationality.clone(),
        gender: None,
        national_id,
        passport_number,
        drivers_license: None,
        tax_id: None,
        document_type: claims.document_type.clone(),
        document_number: claims.document_number.clone(),
        issuing_country: None,
        document_expiry: None,
        document_issue_date: None,
        portrait_image: None,
        street_address: claims.address.as_ref().map(|a| a.line1.clone()).unwrap_or_default(),
        city: claims.address.as_ref().map(|a| a.town.clone()).unwrap_or_default(),
        postal_code: claims.address.as_ref().map(|a| a.postcode.clone()).unwrap_or_default(),
        country: country.clone(),
        is_over_18: is_over_age(date_of_birth, 18),
        is_over_21: is_over_age(date_of_birth, 21),
        is_over_65: is_over_age(date_of_birth, 65),
        is_eu_citizen: is_eu_citizen(&nationality),
        is_resident: false, // Can't determine residency from Onfido alone
        verified_at: Utc::now(),
        verification_level: VerificationLevel::High, // Document + liveness = high
        provider_id: "onfido".to_string(),
        verification_method: "document_liveness".to_string(),
    }
}

// =============================================================================
// Jumio Identity Data
// =============================================================================

/// Identity data from Jumio verification
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumioIdentityData {
    pub first_name: String,
    pub last_name: String,
    pub date_of_birth: String, // YYYY-MM-DD
    #[serde(skip_serializing_if = "Option::is_none")]
    pub place_of_birth: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nationality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
    pub id_type: String,       // "PASSPORT", "DRIVING_LICENSE", "ID_CARD"
    pub id_number: String,
    pub id_country: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<JumioAddress>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumioAddress {
    pub line1: String,
    pub city: String,
    pub postal_code: String,
    pub country: String,
}

fn normalize_jumio(claims: &JumioIdentityData) -> VerifiedIdentityClaims {
    let date_of_birth = NaiveDate::parse_from_str(&claims.date_of_birth, "%Y-%m-%d")
        .unwrap_or_else(|_| NaiveDate::from_ymd_opt(1900, 1, 1).unwrap());

    let nationality = claims.nationality.clone().unwrap_or_default();

    // Map ID type to appropriate field
    let (passport_number, drivers_license, national_id) = match claims.id_type.as_str() {
        "PASSPORT" => (Some(claims.id_number.clone()), None, String::new()),
        "DRIVING_LICENSE" => (None, Some(claims.id_number.clone()), String::new()),
        _ => (None, None, claims.id_number.clone()),
    };

    VerifiedIdentityClaims {
        first_name: claims.first_name.clone(),
        last_name: claims.last_name.clone(),
        date_of_birth,
        place_of_birth: claims.place_of_birth.clone().unwrap_or_default(),
        nationality: nationality.clone(),
        gender: claims.gender.clone(),
        national_id,
        passport_number,
        drivers_license,
        tax_id: None,
        document_type: Some(claims.id_type.clone()),
        document_number: Some(claims.id_number.clone()),
        issuing_country: Some(claims.id_country.clone()),
        document_expiry: None,
        document_issue_date: None,
        portrait_image: None,
        street_address: claims.address.as_ref().map(|a| a.line1.clone()).unwrap_or_default(),
        city: claims.address.as_ref().map(|a| a.city.clone()).unwrap_or_default(),
        postal_code: claims.address.as_ref().map(|a| a.postal_code.clone()).unwrap_or_default(),
        country: claims.address.as_ref().map(|a| a.country.clone()).unwrap_or(claims.id_country.clone()),
        is_over_18: is_over_age(date_of_birth, 18),
        is_over_21: is_over_age(date_of_birth, 21),
        is_over_65: is_over_age(date_of_birth, 65),
        is_eu_citizen: is_eu_citizen(&nationality),
        is_resident: false,
        verified_at: Utc::now(),
        verification_level: VerificationLevel::High,
        provider_id: "jumio".to_string(),
        verification_method: "document_liveness".to_string(),
    }
}

// =============================================================================
// Stripe Identity Claims
// =============================================================================

/// Verified outputs from Stripe Identity
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct StripeVerifiedOutputs {
    pub first_name: String,
    pub last_name: String,
    pub dob: StripeDob,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<StripeAddress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_number_type: Option<String>, // "us_ssn", "br_cpf", etc.
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StripeDob {
    pub day: u32,
    pub month: u32,
    pub year: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct StripeAddress {
    pub line1: String,
    pub city: String,
    pub state: Option<String>,
    pub postal_code: String,
    pub country: String, // ISO 3166-1 alpha-2
}

fn normalize_stripe(claims: &StripeVerifiedOutputs) -> VerifiedIdentityClaims {
    let date_of_birth = NaiveDate::from_ymd_opt(
        claims.dob.year,
        claims.dob.month,
        claims.dob.day,
    )
    .unwrap_or_else(|| NaiveDate::from_ymd_opt(1900, 1, 1).unwrap());

    let country = claims
        .address
        .as_ref()
        .map(|a| a.country.clone())
        .unwrap_or_default();

    // Stripe doesn't provide nationality directly
    let nationality = country.clone();

    VerifiedIdentityClaims {
        first_name: claims.first_name.clone(),
        last_name: claims.last_name.clone(),
        date_of_birth,
        place_of_birth: String::new(),
        nationality: nationality.clone(),
        gender: None,
        national_id: claims.id_number.clone().unwrap_or_default(),
        passport_number: None,
        drivers_license: None,
        tax_id: claims.id_number_type.as_ref()
            .filter(|t| t.contains("tax") || t.contains("cpf"))
            .and_then(|_| claims.id_number.clone()),
        document_type: None,
        document_number: claims.id_number.clone(),
        issuing_country: None,
        document_expiry: None,
        document_issue_date: None,
        portrait_image: None,
        street_address: claims.address.as_ref().map(|a| a.line1.clone()).unwrap_or_default(),
        city: claims.address.as_ref().map(|a| a.city.clone()).unwrap_or_default(),
        postal_code: claims.address.as_ref().map(|a| a.postal_code.clone()).unwrap_or_default(),
        country,
        is_over_18: is_over_age(date_of_birth, 18),
        is_over_21: is_over_age(date_of_birth, 21),
        is_over_65: is_over_age(date_of_birth, 65),
        is_eu_citizen: is_eu_citizen(&nationality),
        is_resident: false,
        verified_at: Utc::now(),
        verification_level: VerificationLevel::High,
        provider_id: "stripe-identity".to_string(),
        verification_method: "document_selfie".to_string(),
    }
}

// =============================================================================
// eIDAS OIDC Claims
// =============================================================================

/// Claims from eIDAS-compliant OIDC provider
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct EidasOidcClaims {
    /// Family name
    pub family_name: String,
    /// Given name
    pub given_name: String,
    /// Date of birth (ISO 8601)
    pub date_of_birth: String,
    /// Person identifier (unique within issuing country)
    pub person_identifier: String,
    /// Issuing country (ISO 3166-1 alpha-2)
    pub issuing_country: String,
    /// Authentication level
    pub acr: String, // "http://eidas.europa.eu/LoA/low", "substantial", "high"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub birth_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub place_of_birth: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
}

fn normalize_eidas(claims: &EidasOidcClaims) -> VerifiedIdentityClaims {
    let date_of_birth = NaiveDate::parse_from_str(&claims.date_of_birth, "%Y-%m-%d")
        .unwrap_or_else(|_| NaiveDate::from_ymd_opt(1900, 1, 1).unwrap());

    let verification_level = if claims.acr.contains("high") {
        VerificationLevel::High
    } else if claims.acr.contains("substantial") {
        VerificationLevel::Substantial
    } else {
        VerificationLevel::Low
    };

    VerifiedIdentityClaims {
        first_name: claims.given_name.clone(),
        last_name: claims.family_name.clone(),
        date_of_birth,
        place_of_birth: claims.place_of_birth.clone().unwrap_or_default(),
        nationality: claims.issuing_country.clone(),
        gender: claims.gender.clone(),
        national_id: claims.person_identifier.clone(),
        passport_number: None,
        drivers_license: None,
        tax_id: None,
        document_type: None,
        document_number: None,
        issuing_country: Some(claims.issuing_country.clone()),
        document_expiry: None,
        document_issue_date: None,
        portrait_image: None,
        street_address: claims.current_address.clone().unwrap_or_default(),
        city: String::new(),
        postal_code: String::new(),
        country: claims.issuing_country.clone(),
        is_over_18: is_over_age(date_of_birth, 18),
        is_over_21: is_over_age(date_of_birth, 21),
        is_over_65: is_over_age(date_of_birth, 65),
        is_eu_citizen: true, // eIDAS is EU-only
        is_resident: true,   // Verified by national eID
        verified_at: Utc::now(),
        verification_level,
        provider_id: "eidas".to_string(),
        verification_method: "eidas_oidc".to_string(),
    }
}

// =============================================================================
// Didit KYC Claims
// =============================================================================

/// Verification data from Didit KYC provider
///
/// Didit provides identity verification through document scanning and
/// liveness detection. This struct captures the data from their API.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DiditVerificationData {
    /// First name from document
    pub first_name: String,
    /// Last name from document
    pub last_name: String,
    /// Full name (if provided separately)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_name: Option<String>,
    /// Date of birth (YYYY-MM-DD format)
    pub date_of_birth: String,
    /// Nationality (ISO 3166-1 alpha-2 country code)
    pub nationality: String,
    /// Type of document used (Passport, ID Card, Driver's License)
    pub document_type: String,
    /// Document number
    pub document_number: String,
    /// Country that issued the document (ISO 3166-1 alpha-2)
    pub issuing_state: String,
    /// Gender (M/F/X)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
    /// Document expiration date (YYYY-MM-DD)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expiration_date: Option<String>,
    /// Document issue date (YYYY-MM-DD)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_of_issue: Option<String>,
    /// Portrait image from document/selfie (base64)
    /// Note: This is NOT included in the credential/Merkle tree for privacy
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portrait_image: Option<String>,
}

fn normalize_didit(claims: &DiditVerificationData) -> VerifiedIdentityClaims {
    let date_of_birth = NaiveDate::parse_from_str(&claims.date_of_birth, "%Y-%m-%d")
        .unwrap_or_else(|_| NaiveDate::from_ymd_opt(1900, 1, 1).unwrap());

    // Parse document expiry date if available
    let document_expiry = claims
        .expiration_date
        .as_ref()
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());

    // Parse document issue date if available
    let document_issue_date = claims
        .date_of_issue
        .as_ref()
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());

    // Map gender code to full word if needed
    let gender = claims.gender.as_ref().map(|g| match g.to_uppercase().as_str() {
        "M" => "Male".to_string(),
        "F" => "Female".to_string(),
        "X" => "Other".to_string(),
        other => other.to_string(),
    });

    // Determine ID fields based on document type
    let (passport_number, drivers_license, national_id) = match claims.document_type.to_lowercase().as_str() {
        "passport" => (Some(claims.document_number.clone()), None, String::new()),
        "driver's license" | "drivers_license" | "driving_license" => {
            (None, Some(claims.document_number.clone()), String::new())
        }
        "id_card" | "national_id" | "id card" => {
            (None, None, claims.document_number.clone())
        }
        _ => (None, None, claims.document_number.clone()),
    };

    VerifiedIdentityClaims {
        first_name: claims.first_name.clone(),
        last_name: claims.last_name.clone(),
        date_of_birth,
        place_of_birth: String::new(), // Didit doesn't typically provide this
        nationality: claims.nationality.clone(),
        gender,
        national_id,
        passport_number,
        drivers_license,
        tax_id: None,
        street_address: String::new(), // Didit doesn't provide address
        city: String::new(),
        postal_code: String::new(),
        country: claims.issuing_state.clone(),
        // Document information (new fields)
        document_type: Some(claims.document_type.clone()),
        document_number: Some(claims.document_number.clone()),
        issuing_country: Some(claims.issuing_state.clone()),
        document_expiry,
        document_issue_date,
        // Portrait image - included in claims for API response, but excluded from credential
        portrait_image: claims.portrait_image.clone(),
        // Derived attributes
        is_over_18: is_over_age(date_of_birth, 18),
        is_over_21: is_over_age(date_of_birth, 21),
        is_over_65: is_over_age(date_of_birth, 65),
        is_eu_citizen: is_eu_citizen(&claims.nationality),
        is_resident: false, // Can't determine residency from document alone
        // Verification metadata
        verified_at: Utc::now(),
        verification_level: VerificationLevel::High, // Document + liveness = high
        provider_id: "didit".to_string(),
        verification_method: "document_liveness".to_string(),
    }
}

// =============================================================================
// Mock Provider Claims
// =============================================================================

/// Claims from mock providers (for testing)
///
/// This mirrors the form submission structure for easy testing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MockClaims {
    pub provider_id: String,
    pub first_name: String,
    pub last_name: String,
    pub date_of_birth: NaiveDate,
    pub place_of_birth: String,
    pub nationality: String,
    pub national_id: String,
    pub street_address: String,
    pub city: String,
    pub postal_code: String,
    pub country: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passport_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drivers_license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tax_id: Option<String>,
    pub verification_level: VerificationLevel,
    pub verification_method: String,
    /// Whether this verifies residency
    pub verifies_residency: bool,
}

fn normalize_mock(claims: &MockClaims) -> VerifiedIdentityClaims {
    let dob = claims.date_of_birth;

    VerifiedIdentityClaims {
        first_name: claims.first_name.clone(),
        last_name: claims.last_name.clone(),
        date_of_birth: dob,
        place_of_birth: claims.place_of_birth.clone(),
        nationality: claims.nationality.clone(),
        gender: claims.gender.clone(),
        national_id: claims.national_id.clone(),
        passport_number: claims.passport_number.clone(),
        drivers_license: claims.drivers_license.clone(),
        tax_id: claims.tax_id.clone(),
        document_type: None,
        document_number: None,
        issuing_country: None,
        document_expiry: None,
        document_issue_date: None,
        portrait_image: None,
        street_address: claims.street_address.clone(),
        city: claims.city.clone(),
        postal_code: claims.postal_code.clone(),
        country: claims.country.clone(),
        is_over_18: is_over_age(dob, 18),
        is_over_21: is_over_age(dob, 21),
        is_over_65: is_over_age(dob, 65),
        is_eu_citizen: is_eu_citizen(&claims.nationality),
        is_resident: claims.verifies_residency,
        verified_at: Utc::now(),
        verification_level: claims.verification_level,
        provider_id: claims.provider_id.clone(),
        verification_method: claims.verification_method.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_mock_claims() {
        let claims = MockClaims {
            provider_id: "mock-test".to_string(),
            first_name: "Jan".to_string(),
            last_name: "Jansen".to_string(),
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
            verification_level: VerificationLevel::Substantial,
            verification_method: "simulated".to_string(),
            verifies_residency: true,
        };

        let raw = RawProviderClaims::Mock(claims);
        let normalized = raw.normalize();

        assert_eq!(normalized.first_name, "Jan");
        assert_eq!(normalized.last_name, "Jansen");
        assert!(normalized.is_over_18);
        assert!(normalized.is_over_21);
        assert!(!normalized.is_over_65);
        assert!(normalized.is_eu_citizen);
        assert!(normalized.is_resident);
    }

    #[test]
    fn test_normalize_bankid_claims() {
        let claims = BankIdCompletionData {
            user: BankIdUser {
                personal_number: "199501011234".to_string(),
                name: "Karin Svensson".to_string(),
                given_name: "Karin".to_string(),
                surname: "Svensson".to_string(),
            },
            signature: "base64...".to_string(),
            cert: None,
        };

        let raw = RawProviderClaims::BankId(claims);
        let normalized = raw.normalize();

        assert_eq!(normalized.first_name, "Karin");
        assert_eq!(normalized.last_name, "Svensson");
        assert_eq!(normalized.national_id, "199501011234");
        assert_eq!(normalized.verification_level, VerificationLevel::High);
        // Born in 1995, should be over 18 and 21 but not 65
        assert!(normalized.is_over_18);
        assert!(normalized.is_over_21);
        assert!(!normalized.is_over_65);
    }

    #[test]
    fn test_normalize_onfido_claims() {
        let claims = OnfidoApplicantData {
            first_name: "John".to_string(),
            last_name: "Smith".to_string(),
            dob: "1990-06-15".to_string(),
            address: Some(OnfidoAddress {
                line1: "123 Main St".to_string(),
                line2: None,
                town: "London".to_string(),
                postcode: "SW1A 1AA".to_string(),
                country: "GBR".to_string(),
            }),
            nationality: Some("British".to_string()),
            document_type: Some("passport".to_string()),
            document_number: Some("AB1234567".to_string()),
            id_numbers: vec![],
        };

        let raw = RawProviderClaims::Onfido(claims);
        let normalized = raw.normalize();

        assert_eq!(normalized.first_name, "John");
        assert_eq!(normalized.last_name, "Smith");
        assert_eq!(normalized.passport_number, Some("AB1234567".to_string()));
        assert_eq!(normalized.city, "London");
        assert!(!normalized.is_eu_citizen); // British is not in EU list
    }
}
