//! Provider registry for managing digital identity providers

use super::traits::{DigitalIdentityProvider, ProviderInfoExtended};
use std::collections::HashMap;
use std::sync::Arc;

/// Registry for managing multiple identity providers
///
/// Stores provider instances and provides lookup by ID.
pub struct ProviderRegistry {
    providers: HashMap<String, Arc<dyn DigitalIdentityProvider>>,
}

impl ProviderRegistry {
    /// Create a new empty registry
    pub fn new() -> Self {
        Self {
            providers: HashMap::new(),
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

    /// Get a provider by ID
    pub fn get(&self, provider_id: &str) -> Option<Arc<dyn DigitalIdentityProvider>> {
        self.providers.get(provider_id).cloned()
    }

    /// List all registered providers
    pub fn list(&self) -> Vec<ProviderInfoExtended> {
        self.providers
            .values()
            .map(|p| ProviderInfoExtended::from_provider(p.as_ref()))
            .collect()
    }

    /// Get provider IDs
    pub fn provider_ids(&self) -> Vec<String> {
        self.providers.keys().cloned().collect()
    }

    /// Check if a provider is registered
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
    use crate::models::{ProviderInfo, VerificationLevel};
    use crate::normalizer::RawProviderClaims;
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

        fn info(&self) -> ProviderInfo {
            ProviderInfo {
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
        assert_eq!(list[0].base.id, "test-1");
    }
}
