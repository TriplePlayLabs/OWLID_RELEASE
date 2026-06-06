//! Provider registry for managing digital identity providers

use super::traits::{DigitalIdentityProvider, ProviderInfo};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

/// Registry for managing multiple identity providers.
///
/// Stores provider instances and provides lookup by ID.
///
/// `disabled` is the runtime override controlled by the operator via
/// `POST /admin/providers/{id}/{enable,disable}`. The set is loaded from
/// the `provider_settings` table at boot and updated atomically when an
/// admin flips a provider — handlers see the change without a restart.
pub struct ProviderRegistry {
    providers: HashMap<String, Arc<dyn DigitalIdentityProvider>>,
    disabled: Arc<RwLock<HashSet<String>>>,
}

impl ProviderRegistry {
    /// Create a new empty registry
    pub fn new() -> Self {
        Self {
            providers: HashMap::new(),
            disabled: Arc::new(RwLock::new(HashSet::new())),
        }
    }

    /// Register a provider
    pub fn register<P: DigitalIdentityProvider + 'static>(&mut self, provider: P) {
        let id = provider.provider_id().to_string();
        self.providers.insert(id, Arc::new(provider));
    }

    /// Register a provider that's already wrapped in Arc
    pub fn register_arc(&mut self, provider: Arc<dyn DigitalIdentityProvider>) {
        let id = provider.provider_id().to_string();
        self.providers.insert(id, provider);
    }

    /// Look up a provider by ID. Returns the instance regardless of the
    /// enabled flag — callers gating session-creation flows should
    /// additionally consult `is_enabled` so disabled providers fail closed.
    pub fn get(&self, provider_id: &str) -> Option<Arc<dyn DigitalIdentityProvider>> {
        self.providers.get(provider_id).cloned()
    }

    /// True when the provider is registered AND not in the disabled set.
    pub fn is_enabled(&self, provider_id: &str) -> bool {
        if !self.contains(provider_id) {
            return false;
        }
        let d = self.disabled.read().expect("disabled lock poisoned");
        !d.contains(provider_id)
    }

    /// Replace the disabled set in one shot. Used at boot when loading
    /// persisted state from `provider_settings`.
    pub fn set_disabled(&self, disabled_ids: impl IntoIterator<Item = String>) {
        let mut d = self.disabled.write().expect("disabled lock poisoned");
        d.clear();
        d.extend(disabled_ids);
    }

    /// Flip a single provider on/off in the in-memory set. Persistence is
    /// the caller's responsibility.
    pub fn set_enabled(&self, provider_id: &str, enabled: bool) {
        let mut d = self.disabled.write().expect("disabled lock poisoned");
        if enabled {
            d.remove(provider_id);
        } else {
            d.insert(provider_id.to_string());
        }
    }

    /// List all registered providers with their current enabled state.
    pub fn list(&self) -> Vec<ProviderInfo> {
        let disabled = self.disabled.read().expect("disabled lock poisoned");
        self.providers
            .values()
            .map(|p| {
                let enabled = !disabled.contains(p.provider_id());
                ProviderInfo::from_provider(p.as_ref(), enabled)
            })
            .collect()
    }

    /// Get provider IDs
    pub fn provider_ids(&self) -> Vec<String> {
        self.providers.keys().cloned().collect()
    }

    /// Check if a provider is registered (regardless of enabled state).
    pub fn contains(&self, provider_id: &str) -> bool {
        self.providers.contains_key(provider_id)
    }

    /// Number of registered providers
    pub fn len(&self) -> usize {
        self.providers.len()
    }

    /// Check if registry is empty
    pub fn is_empty(&self) -> bool {
        self.providers.is_empty()
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ProviderDescriptor, VerificationLevel};

    use crate::provider::{ProviderFlowType, VerificationStart};
    use async_trait::async_trait;
    use uuid::Uuid;

    struct TestProvider {
        id: String,
    }

    #[async_trait]
    impl DigitalIdentityProvider for TestProvider {
        fn provider_id(&self) -> &str {
            &self.id
        }

        fn provider_type(&self) -> ProviderFlowType {
            ProviderFlowType::FormBased
        }

        fn info(&self) -> ProviderDescriptor {
            ProviderDescriptor {
                id: self.id.clone(),
                name: "Test Provider".to_string(),
                description: "A test provider".to_string(),
                verification_levels: vec![VerificationLevel::Low],
                country: "Test".to_string(),
            }
        }

        fn verification_level(&self) -> VerificationLevel {
            VerificationLevel::Low
        }

        async fn start_verification(
            &self,
            _session_id: Uuid,
        ) -> crate::error::Result<VerificationStart> {
            Ok(VerificationStart::Form {
                config: Default::default(),
            })
        }
    }

    #[test]
    fn test_registry_operations() {
        let mut registry = ProviderRegistry::new();

        // Register a provider
        registry.register(TestProvider {
            id: "test-1".to_string(),
        });

        assert!(registry.contains("test-1"));
        assert!(!registry.contains("test-2"));
        assert_eq!(registry.len(), 1);

        // Get provider
        let provider = registry.get("test-1");
        assert!(provider.is_some());
        assert_eq!(provider.unwrap().provider_id(), "test-1");

        // List providers
        let list = registry.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].descriptor.id, "test-1");
        assert!(list[0].enabled);
    }
}
