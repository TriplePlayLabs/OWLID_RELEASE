pub mod credentials;
pub mod error;
pub mod issuer_keys;
pub mod pool;
pub mod provider_settings;
pub mod recovery;
pub mod service_secrets;

pub use credentials::{CredentialRepository, IssuedCredential};
pub use error::{DatabaseError, Result};
pub use issuer_keys::{IssuerKey, IssuerKeysRepository};
pub use pool::{DbPool, create_pool};
pub use provider_settings::{ProviderSetting, ProviderSettingsRepository};
pub use recovery::{CredentialRecoveryBackup, CredentialRecoveryRepository};
pub use service_secrets::ServiceSecretsRepository;
