//! T-008: Credential schema validation
//!
//! Provides schema definitions and validation for credential attributes.
//! Schemas enforce required fields and type constraints on documents.

use crate::error::ProofSystemError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Type constraint for a credential attribute
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AttributeType {
    /// JSON string
    String,
    /// JSON number (integer)
    Integer,
    /// JSON number (float or integer)
    Number,
    /// JSON boolean
    Boolean,
    /// ISO 8601 date string (YYYY-MM-DD)
    Date,
    /// String that must be one of the given values
    StringEnum(Vec<String>),
    /// JSON array
    Array,
    /// JSON object
    Object,
    /// Any valid JSON value
    Any,
}

impl AttributeType {
    /// Check if a JSON value matches this type constraint
    pub fn matches(&self, value: &serde_json::Value) -> bool {
        match self {
            AttributeType::String => value.is_string(),
            AttributeType::Integer => value.is_i64() || value.is_u64(),
            AttributeType::Number => value.is_number(),
            AttributeType::Boolean => value.is_boolean(),
            AttributeType::Date => {
                value.as_str().map_or(false, |s| {
                    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
                })
            }
            AttributeType::StringEnum(allowed) => {
                value.as_str().map_or(false, |s| allowed.iter().any(|a| a == s))
            }
            AttributeType::Array => value.is_array(),
            AttributeType::Object => value.is_object(),
            AttributeType::Any => true,
        }
    }

    fn type_name(&self) -> &str {
        match self {
            AttributeType::String => "string",
            AttributeType::Integer => "integer",
            AttributeType::Number => "number",
            AttributeType::Boolean => "boolean",
            AttributeType::Date => "date (YYYY-MM-DD)",
            AttributeType::StringEnum(_) => "string enum",
            AttributeType::Array => "array",
            AttributeType::Object => "object",
            AttributeType::Any => "any",
        }
    }
}

/// Schema definition for credential attributes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialSchema {
    /// Unique identifier for this schema
    pub schema_id: String,
    /// Human-readable name
    pub name: String,
    /// Schema version
    pub version: String,
    /// Required attribute names (must be present)
    pub required_attributes: Vec<String>,
    /// Type constraints per attribute (if not listed, any type is accepted)
    pub attribute_types: BTreeMap<String, AttributeType>,
}

impl CredentialSchema {
    /// Validate a set of attributes against this schema
    pub fn validate(
        &self,
        attributes: &BTreeMap<String, serde_json::Value>,
    ) -> Result<(), ProofSystemError> {
        // Check required attributes
        for required in &self.required_attributes {
            if !attributes.contains_key(required) {
                return Err(ProofSystemError::SchemaValidation(format!(
                    "Missing required attribute '{}' (schema: {})",
                    required, self.schema_id
                )));
            }
        }

        // Check type constraints
        for (key, expected_type) in &self.attribute_types {
            if let Some(value) = attributes.get(key) {
                if !expected_type.matches(value) {
                    return Err(ProofSystemError::SchemaValidation(format!(
                        "Attribute '{}' must be {} but got {} (schema: {})",
                        key,
                        expected_type.type_name(),
                        value_type_name(value),
                        self.schema_id
                    )));
                }
            }
        }

        Ok(())
    }

    /// Built-in identity credential schema v1.
    /// Matches the VerifiedIdentityClaims structure from the issuer service normalizer.
    pub fn identity_v1() -> Self {
        let mut types = BTreeMap::new();
        types.insert("issuerKey".to_string(), AttributeType::String);
        types.insert("firstName".to_string(), AttributeType::String);
        types.insert("lastName".to_string(), AttributeType::String);
        types.insert("dateOfBirth".to_string(), AttributeType::Date);
        types.insert("nationality".to_string(), AttributeType::String);
        types.insert("nationalId".to_string(), AttributeType::String);
        types.insert("isOver18".to_string(), AttributeType::Boolean);
        types.insert("isOver21".to_string(), AttributeType::Boolean);
        types.insert("isOver65".to_string(), AttributeType::Boolean);
        types.insert("isEuCitizen".to_string(), AttributeType::Boolean);
        types.insert("verificationLevel".to_string(), AttributeType::Integer);

        Self {
            schema_id: "owlid:identity:v1".to_string(),
            name: "OwlID Identity Credential".to_string(),
            version: "1.0.0".to_string(),
            required_attributes: vec![
                "issuerKey".to_string(),
                "firstName".to_string(),
                "lastName".to_string(),
                "dateOfBirth".to_string(),
            ],
            attribute_types: types,
        }
    }
}

fn value_type_name(v: &serde_json::Value) -> &str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_identity_schema_valid() {
        let schema = CredentialSchema::identity_v1();
        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!("abc123"));
        attrs.insert("ownerKey".to_string(), json!("def456"));
        attrs.insert("firstName".to_string(), json!("Jan"));
        attrs.insert("lastName".to_string(), json!("Jansen"));
        attrs.insert("dateOfBirth".to_string(), json!("1990-01-15"));
        attrs.insert("nationality".to_string(), json!("Dutch"));
        attrs.insert("isOver18".to_string(), json!(true));

        assert!(schema.validate(&attrs).is_ok());
    }

    #[test]
    fn test_identity_schema_missing_required() {
        let schema = CredentialSchema::identity_v1();
        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!("abc123"));
        // Missing firstName, lastName, dateOfBirth

        let err = schema.validate(&attrs).unwrap_err();
        assert!(err.to_string().contains("firstName"));
    }

    #[test]
    fn test_identity_schema_wrong_type() {
        let schema = CredentialSchema::identity_v1();
        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!("abc123"));
        attrs.insert("ownerKey".to_string(), json!("def456"));
        attrs.insert("firstName".to_string(), json!(123)); // Wrong type
        attrs.insert("lastName".to_string(), json!("Jansen"));
        attrs.insert("dateOfBirth".to_string(), json!("1990-01-15"));

        let err = schema.validate(&attrs).unwrap_err();
        assert!(err.to_string().contains("firstName"));
        assert!(err.to_string().contains("string"));
    }

    #[test]
    fn test_date_validation() {
        let schema = CredentialSchema::identity_v1();
        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!("abc123"));
        attrs.insert("ownerKey".to_string(), json!("def456"));
        attrs.insert("firstName".to_string(), json!("Jan"));
        attrs.insert("lastName".to_string(), json!("Jansen"));
        attrs.insert("dateOfBirth".to_string(), json!("not-a-date"));

        let err = schema.validate(&attrs).unwrap_err();
        assert!(err.to_string().contains("dateOfBirth"));
    }

    #[test]
    fn test_string_enum_type() {
        let mut types = BTreeMap::new();
        types.insert(
            "status".to_string(),
            AttributeType::StringEnum(vec!["active".to_string(), "inactive".to_string()]),
        );

        let schema = CredentialSchema {
            schema_id: "test:enum".to_string(),
            name: "Test".to_string(),
            version: "1.0.0".to_string(),
            required_attributes: vec!["status".to_string()],
            attribute_types: types,
        };

        let mut valid = BTreeMap::new();
        valid.insert("status".to_string(), json!("active"));
        assert!(schema.validate(&valid).is_ok());

        let mut invalid = BTreeMap::new();
        invalid.insert("status".to_string(), json!("unknown"));
        assert!(schema.validate(&invalid).is_err());
    }

    #[test]
    fn test_extra_attributes_allowed() {
        let schema = CredentialSchema::identity_v1();
        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!("abc123"));
        attrs.insert("ownerKey".to_string(), json!("def456"));
        attrs.insert("firstName".to_string(), json!("Jan"));
        attrs.insert("lastName".to_string(), json!("Jansen"));
        attrs.insert("dateOfBirth".to_string(), json!("1990-01-15"));
        attrs.insert("customField".to_string(), json!("anything goes"));

        assert!(schema.validate(&attrs).is_ok());
    }
}
