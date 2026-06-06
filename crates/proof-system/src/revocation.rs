use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Trait for checking if credentials are revoked
pub trait RevocationChecker: Send + Sync {
    /// Check if a credential is revoked. The id is the SD-JWT VC
    /// `credential_id` (raw 32-byte hex).
    fn is_revoked(&self, credential_id: &str) -> bool;
}

/// Revocation status for a credential
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum RevocationStatus {
    Active,
    Revoked,
    Suspended,
}

/// Revocation entry for a credential
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevocationEntry {
    /// SD-JWT VC credential_id (unique identifier)
    pub credential_id: String,
    /// Current status
    pub status: RevocationStatus,
    /// Timestamp when revoked/suspended
    pub timestamp: DateTime<Utc>,
    /// Reason for revocation
    pub reason: Option<String>,
    /// Issuer who revoked it
    pub issuer_key: String,
}

impl RevocationEntry {
    pub fn new(
        credential_id: String,
        status: RevocationStatus,
        issuer_key: String,
        reason: Option<String>,
    ) -> Self {
        Self {
            credential_id,
            status,
            timestamp: Utc::now(),
            reason,
            issuer_key,
        }
    }

    pub fn is_revoked(&self) -> bool {
        matches!(
            self.status,
            RevocationStatus::Revoked | RevocationStatus::Suspended
        )
    }
}

/// In-memory revocation registry
/// In production, this would be backed by a database or blockchain
pub struct RevocationRegistry {
    entries: std::sync::RwLock<std::collections::HashMap<String, RevocationEntry>>,
}

impl RevocationRegistry {
    pub fn new() -> Self {
        Self {
            entries: std::sync::RwLock::new(std::collections::HashMap::new()),
        }
    }

    /// Add a revocation entry
    pub fn add(&self, entry: RevocationEntry) {
        let mut entries = self.entries.write().unwrap_or_else(|poisoned| {
            tracing::warn!("RevocationRegistry lock was poisoned, recovering");
            poisoned.into_inner()
        });
        entries.insert(entry.credential_id.clone(), entry);
    }

    /// Check if a credential is revoked
    pub fn is_revoked(&self, credential_id: &str) -> bool {
        let entries = self.entries.read().unwrap_or_else(|poisoned| {
            tracing::warn!("RevocationRegistry lock was poisoned, recovering");
            poisoned.into_inner()
        });
        entries
            .get(credential_id)
            .map(|e| e.is_revoked())
            .unwrap_or(false)
    }

    /// Get revocation status
    pub fn get_status(&self, credential_id: &str) -> Option<RevocationEntry> {
        let entries = self.entries.read().unwrap_or_else(|poisoned| {
            tracing::warn!("RevocationRegistry lock was poisoned, recovering");
            poisoned.into_inner()
        });
        entries.get(credential_id).cloned()
    }

    /// Revoke a credential
    pub fn revoke(&self, credential_id: String, issuer_key: String, reason: Option<String>) {
        let entry =
            RevocationEntry::new(credential_id, RevocationStatus::Revoked, issuer_key, reason);
        self.add(entry);
    }

    /// Suspend a credential
    pub fn suspend(&self, credential_id: String, issuer_key: String, reason: Option<String>) {
        let entry = RevocationEntry::new(
            credential_id,
            RevocationStatus::Suspended,
            issuer_key,
            reason,
        );
        self.add(entry);
    }

    /// Reactivate a suspended credential
    pub fn reactivate(&self, credential_id: String, issuer_key: String) {
        let entry = RevocationEntry::new(credential_id, RevocationStatus::Active, issuer_key, None);
        self.add(entry);
    }

    /// List all revoked/suspended credentials
    pub fn list_revoked(&self) -> Vec<RevocationEntry> {
        let entries = self.entries.read().unwrap_or_else(|poisoned| {
            tracing::warn!("RevocationRegistry lock was poisoned, recovering");
            poisoned.into_inner()
        });
        entries
            .values()
            .filter(|e| e.is_revoked())
            .cloned()
            .collect()
    }
}

impl Default for RevocationRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl RevocationChecker for RevocationRegistry {
    fn is_revoked(&self, credential_id: &str) -> bool {
        self.is_revoked(credential_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_revocation_registry() {
        let registry = RevocationRegistry::new();

        // Initially not revoked
        assert!(!registry.is_revoked("hash123"));

        // Revoke
        registry.revoke(
            "hash123".to_string(),
            "issuer1".to_string(),
            Some("Expired".to_string()),
        );
        assert!(registry.is_revoked("hash123"));

        // Check status
        let status = registry.get_status("hash123").unwrap();
        assert_eq!(status.status, RevocationStatus::Revoked);
        assert_eq!(status.reason, Some("Expired".to_string()));
    }

    #[test]
    fn test_suspend_and_reactivate() {
        let registry = RevocationRegistry::new();

        // Suspend
        registry.suspend(
            "hash456".to_string(),
            "issuer1".to_string(),
            Some("Under review".to_string()),
        );
        assert!(registry.is_revoked("hash456"));

        // Reactivate
        registry.reactivate("hash456".to_string(), "issuer1".to_string());
        assert!(!registry.is_revoked("hash456"));
    }
}
