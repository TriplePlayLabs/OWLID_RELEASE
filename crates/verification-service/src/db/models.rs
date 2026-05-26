#![allow(dead_code)] // intentional API surface / serde fields
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// API Key for authentication
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ApiKey {
    pub id: Uuid,
    pub key_hash: String,
    pub name: String,
    pub description: Option<String>,
    pub permissions: serde_json::Value,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_by: Option<String>,
    pub key_type: String,
    pub environment: String,
    pub key_preview: Option<String>,
}

impl ApiKey {
    /// Check if the API key has a specific permission
    pub fn has_permission(&self, permission: &str) -> bool {
        if let Some(perms) = self.permissions.as_array() {
            return perms.iter().any(|p| p.as_str() == Some(permission));
        }
        false
    }

    /// Check if the API key is valid (active and not expired)
    pub fn is_valid(&self) -> bool {
        if !self.is_active {
            return false;
        }

        if let Some(expires_at) = self.expires_at {
            if expires_at < Utc::now() {
                return false;
            }
        }

        true
    }
}

/// Trusted issuer
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct TrustedIssuer {
    pub id: Uuid,
    pub public_key: String,
    pub name: String,
    pub description: Option<String>,
    pub issuer_url: Option<String>,
    pub is_active: bool,
    pub added_at: DateTime<Utc>,
    pub added_by: Option<String>,
    pub metadata: serde_json::Value,
}

/// Revocation entry
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Revocation {
    pub id: Uuid,
    pub credential_id: String,
    pub issuer_public_key: String,
    pub status: String,
    pub reason: Option<String>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub suspended_at: Option<DateTime<Utc>>,
    pub reactivated_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub metadata: serde_json::Value,
}

/// Verification log entry
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct VerificationLog {
    pub id: Uuid,
    pub proof_hash: String,
    pub challenge_hash: String,
    pub issuer_public_key: Option<String>,
    pub verification_result: String,
    pub failure_reason: Option<String>,
    pub verified_at: DateTime<Utc>,
    pub verifier_id: Option<String>,
    pub metadata: serde_json::Value,
    pub expires_at: DateTime<Utc>,
}

/// Verification metrics
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct VerificationMetrics {
    pub id: Uuid,
    pub period_start: DateTime<Utc>,
    pub period_end: DateTime<Utc>,
    pub total_verifications: i64,
    pub successful_verifications: i64,
    pub failed_verifications: i64,
    pub unique_verifiers: i64,
    pub avg_response_time_ms: Option<f64>,
    pub created_at: DateTime<Utc>,
}

impl VerificationMetrics {
    pub fn success_rate(&self) -> f64 {
        if self.total_verifications == 0 {
            return 0.0;
        }
        (self.successful_verifications as f64 / self.total_verifications as f64) * 100.0
    }
}

/// Audit event
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct AuditEvent {
    pub id: Uuid,
    pub event_type: String,
    pub entity_type: String,
    pub entity_id: String,
    pub actor: Option<String>,
    pub action_hash: String,
    pub occurred_at: DateTime<Utc>,
    pub metadata: serde_json::Value,
}

/// Rate limit entry
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct RateLimit {
    pub id: Uuid,
    pub identifier: String,
    pub endpoint: String,
    pub request_count: i32,
    pub window_start: DateTime<Utc>,
    pub window_end: DateTime<Utc>,
}
