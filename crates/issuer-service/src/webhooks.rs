//! Webhook handling for async identity providers
//!
//! This module provides webhook signature verification and payload parsing
//! for providers like Onfido, Jumio, and Stripe Identity.

use crate::error::{IdpError, Result};
use crate::provider::WebhookPayload;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::collections::HashMap;

type HmacSha256 = Hmac<Sha256>;

/// Webhook signature verification result
#[derive(Debug, Clone)]
pub struct VerifiedWebhook {
    /// The verified payload
    pub payload: WebhookPayload,
    /// Provider-specific event type
    pub event_type: String,
    /// Provider-specific resource ID
    pub resource_id: String,
}

/// Trait for provider-specific webhook handling
pub trait WebhookHandler: Send + Sync {
    /// Get the provider ID this handler is for
    fn provider_id(&self) -> &str;

    /// Verify the webhook signature
    ///
    /// Returns Ok if signature is valid, Err if invalid or missing
    fn verify_signature(&self, payload: &WebhookPayload, secret: &str) -> Result<()>;

    /// Extract the event type from the payload
    fn extract_event_type(&self, payload: &WebhookPayload) -> Result<String>;

    /// Extract the resource ID (session/applicant ID) from the payload
    fn extract_resource_id(&self, payload: &WebhookPayload) -> Result<String>;
}

/// Onfido webhook handler
pub struct OnfidoWebhookHandler;

impl WebhookHandler for OnfidoWebhookHandler {
    fn provider_id(&self) -> &str {
        "onfido"
    }

    fn verify_signature(&self, payload: &WebhookPayload, secret: &str) -> Result<()> {
        // Onfido uses X-SHA2-Signature header
        let signature = payload
            .headers
            .get("x-sha2-signature")
            .or_else(|| payload.headers.get("X-SHA2-Signature"))
            .ok_or_else(|| IdpError::InvalidField {
                field: "signature".to_string(),
                reason: "Missing X-SHA2-Signature header".to_string(),
            })?;

        // Verify HMAC-SHA256
        let body_str = serde_json::to_string(&payload.body)
            .map_err(|e| IdpError::Serialization(e.to_string()))?;

        verify_hmac_sha256(secret.as_bytes(), body_str.as_bytes(), signature)?;
        Ok(())
    }

    fn extract_event_type(&self, payload: &WebhookPayload) -> Result<String> {
        payload
            .body
            .get("action")
            .and_then(|v| v.as_str())
            .map(String::from)
            .ok_or_else(|| IdpError::InvalidField {
                field: "action".to_string(),
                reason: "Missing action field in Onfido webhook".to_string(),
            })
    }

    fn extract_resource_id(&self, payload: &WebhookPayload) -> Result<String> {
        // Onfido sends applicant_id in the payload
        payload
            .body
            .get("object")
            .and_then(|obj| obj.get("applicant_id"))
            .and_then(|v| v.as_str())
            .map(String::from)
            .or_else(|| {
                payload
                    .body
                    .get("applicant_id")
                    .and_then(|v| v.as_str())
                    .map(String::from)
            })
            .ok_or_else(|| IdpError::InvalidField {
                field: "applicant_id".to_string(),
                reason: "Missing applicant_id in Onfido webhook".to_string(),
            })
    }
}

/// Jumio webhook handler
pub struct JumioWebhookHandler;

impl WebhookHandler for JumioWebhookHandler {
    fn provider_id(&self) -> &str {
        "jumio"
    }

    fn verify_signature(&self, payload: &WebhookPayload, secret: &str) -> Result<()> {
        // Jumio uses a callback token in the body or Authorization header
        let auth_header = payload
            .headers
            .get("authorization")
            .or_else(|| payload.headers.get("Authorization"));

        if let Some(auth) = auth_header {
            // Check Basic auth token matches
            let expected = format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(format!("{}:", secret))
            );
            if auth != &expected {
                return Err(IdpError::InvalidField {
                    field: "authorization".to_string(),
                    reason: "Invalid authorization header".to_string(),
                });
            }
        }

        Ok(())
    }

    fn extract_event_type(&self, payload: &WebhookPayload) -> Result<String> {
        // Jumio sends status as the event type
        payload
            .body
            .get("verificationStatus")
            .and_then(|v| v.as_str())
            .map(String::from)
            .ok_or_else(|| IdpError::InvalidField {
                field: "verificationStatus".to_string(),
                reason: "Missing verificationStatus in Jumio webhook".to_string(),
            })
    }

    fn extract_resource_id(&self, payload: &WebhookPayload) -> Result<String> {
        payload
            .body
            .get("scanReference")
            .and_then(|v| v.as_str())
            .map(String::from)
            .or_else(|| {
                payload
                    .body
                    .get("transactionReference")
                    .and_then(|v| v.as_str())
                    .map(String::from)
            })
            .ok_or_else(|| IdpError::InvalidField {
                field: "scanReference".to_string(),
                reason: "Missing scanReference in Jumio webhook".to_string(),
            })
    }
}

/// Stripe Identity webhook handler
pub struct StripeWebhookHandler;

impl WebhookHandler for StripeWebhookHandler {
    fn provider_id(&self) -> &str {
        "stripe-identity"
    }

    fn verify_signature(&self, payload: &WebhookPayload, secret: &str) -> Result<()> {
        // Stripe uses Stripe-Signature header with timestamp and signature
        let signature_header = payload
            .headers
            .get("stripe-signature")
            .or_else(|| payload.headers.get("Stripe-Signature"))
            .ok_or_else(|| IdpError::InvalidField {
                field: "signature".to_string(),
                reason: "Missing Stripe-Signature header".to_string(),
            })?;

        // Parse Stripe signature format: t=timestamp,v1=signature
        let parts: HashMap<&str, &str> = signature_header
            .split(',')
            .filter_map(|p| {
                let mut split = p.splitn(2, '=');
                Some((split.next()?, split.next()?))
            })
            .collect();

        let timestamp = parts.get("t").ok_or_else(|| IdpError::InvalidField {
            field: "timestamp".to_string(),
            reason: "Missing timestamp in Stripe signature".to_string(),
        })?;

        let signature = parts.get("v1").ok_or_else(|| IdpError::InvalidField {
            field: "signature".to_string(),
            reason: "Missing v1 signature".to_string(),
        })?;

        // Build signed payload: {timestamp}.{body}
        let body_str = serde_json::to_string(&payload.body)
            .map_err(|e| IdpError::Serialization(e.to_string()))?;
        let signed_payload = format!("{}.{}", timestamp, body_str);

        verify_hmac_sha256(secret.as_bytes(), signed_payload.as_bytes(), signature)?;
        Ok(())
    }

    fn extract_event_type(&self, payload: &WebhookPayload) -> Result<String> {
        payload
            .body
            .get("type")
            .and_then(|v| v.as_str())
            .map(String::from)
            .ok_or_else(|| IdpError::InvalidField {
                field: "type".to_string(),
                reason: "Missing type in Stripe webhook".to_string(),
            })
    }

    fn extract_resource_id(&self, payload: &WebhookPayload) -> Result<String> {
        // Stripe sends verification_session in data.object
        payload
            .body
            .get("data")
            .and_then(|d| d.get("object"))
            .and_then(|o| o.get("id"))
            .and_then(|v| v.as_str())
            .map(String::from)
            .ok_or_else(|| IdpError::InvalidField {
                field: "verification_session_id".to_string(),
                reason: "Missing verification session ID in Stripe webhook".to_string(),
            })
    }
}

/// Registry of webhook handlers
pub struct WebhookHandlerRegistry {
    handlers: HashMap<String, Box<dyn WebhookHandler>>,
}

impl WebhookHandlerRegistry {
    pub fn new() -> Self {
        let mut registry = Self {
            handlers: HashMap::new(),
        };

        // Register default handlers
        registry.register(Box::new(OnfidoWebhookHandler));
        registry.register(Box::new(JumioWebhookHandler));
        registry.register(Box::new(StripeWebhookHandler));

        registry
    }

    pub fn register(&mut self, handler: Box<dyn WebhookHandler>) {
        let id = handler.provider_id().to_string();
        self.handlers.insert(id, handler);
    }

    pub fn get(&self, provider_id: &str) -> Option<&dyn WebhookHandler> {
        self.handlers.get(provider_id).map(|h| h.as_ref())
    }

    /// Process a webhook, verifying signature and extracting metadata
    pub fn process(&self, payload: WebhookPayload, secret: &str) -> Result<VerifiedWebhook> {
        let handler = self
            .get(&payload.provider_id)
            .ok_or_else(|| IdpError::ProviderNotFound(payload.provider_id.clone()))?;

        // Verify signature
        handler.verify_signature(&payload, secret)?;

        // Extract event type and resource ID
        let event_type = handler.extract_event_type(&payload)?;
        let resource_id = handler.extract_resource_id(&payload)?;

        Ok(VerifiedWebhook {
            payload,
            event_type,
            resource_id,
        })
    }
}

impl Default for WebhookHandlerRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Verify HMAC-SHA256 signature
fn verify_hmac_sha256(key: &[u8], data: &[u8], expected_signature: &str) -> Result<()> {
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|e| IdpError::Internal(format!("HMAC error: {}", e)))?;

    mac.update(data);

    // Try hex-encoded signature first
    if let Ok(expected_bytes) = hex::decode(expected_signature) {
        if mac.clone().verify_slice(&expected_bytes).is_ok() {
            return Ok(());
        }
    }

    // Try base64-encoded signature
    if let Ok(expected_bytes) = base64::engine::general_purpose::STANDARD.decode(expected_signature)
    {
        if mac.verify_slice(&expected_bytes).is_ok() {
            return Ok(());
        }
    }

    Err(IdpError::InvalidField {
        field: "signature".to_string(),
        reason: "Invalid webhook signature".to_string(),
    })
}

// Re-export base64 engine for use in handlers
use base64::Engine;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_webhook_handler_registry() {
        let registry = WebhookHandlerRegistry::new();

        assert!(registry.get("onfido").is_some());
        assert!(registry.get("jumio").is_some());
        assert!(registry.get("stripe-identity").is_some());
        assert!(registry.get("unknown").is_none());
    }

    #[test]
    fn test_onfido_extract_event_type() {
        let handler = OnfidoWebhookHandler;
        let payload = WebhookPayload {
            body: serde_json::json!({
                "action": "verification.completed"
            }),
            headers: HashMap::new(),
            provider_id: "onfido".to_string(),
        };

        let event_type = handler.extract_event_type(&payload).unwrap();
        assert_eq!(event_type, "verification.completed");
    }

    #[test]
    fn test_stripe_extract_resource_id() {
        let handler = StripeWebhookHandler;
        let payload = WebhookPayload {
            body: serde_json::json!({
                "type": "identity.verification_session.verified",
                "data": {
                    "object": {
                        "id": "vs_1234567890"
                    }
                }
            }),
            headers: HashMap::new(),
            provider_id: "stripe-identity".to_string(),
        };

        let resource_id = handler.extract_resource_id(&payload).unwrap();
        assert_eq!(resource_id, "vs_1234567890");
    }
}
