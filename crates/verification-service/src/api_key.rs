//! API key format: `owlid_{type}_{env}_{suffix}`.

use rand::RngCore;
use serde::{Deserialize, Serialize};

const PREFIX: &str = "owlid";
const SUFFIX_BYTES: usize = 32;
const BASE62: &[u8; 62] =
    b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema, sqlx::Type,
)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "VARCHAR", rename_all = "lowercase")]
pub enum KeyType {
    /// Publishable key — safe to ship in browser bundles. Restricted to
    /// the `verify` permission only.
    Pk,
    /// Secret key — server-only. Any permission set is allowed.
    Sk,
}

impl KeyType {
    pub fn as_str(self) -> &'static str {
        match self {
            KeyType::Pk => "pk",
            KeyType::Sk => "sk",
        }
    }
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema, sqlx::Type,
)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "VARCHAR", rename_all = "lowercase")]
pub enum Environment {
    Live,
    Test,
}

impl Environment {
    pub fn as_str(self) -> &'static str {
        match self {
            Environment::Live => "live",
            Environment::Test => "test",
        }
    }
}

pub struct GeneratedKey {
    pub raw: String,
    pub preview: String,
    pub key_type: KeyType,
    pub environment: Environment,
}

pub fn generate(key_type: KeyType, environment: Environment) -> GeneratedKey {
    let mut bytes = [0u8; SUFFIX_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let suffix = encode_base62(&bytes);

    let raw = format!(
        "{PREFIX}_{kt}_{env}_{suffix}",
        kt = key_type.as_str(),
        env = environment.as_str(),
    );
    let preview = preview_for(&raw);

    GeneratedKey {
        raw,
        preview,
        key_type,
        environment,
    }
}

/// `owlid_sk_live_AbCd…WxYz` — first prefix segment + last 4 of the random
/// suffix. Always safe to log / display.
pub fn preview_for(raw: &str) -> String {
    // The fixed prefix `owlid_{kt}_{env}_` is up to 16 chars. We show
    // everything before the suffix, an ellipsis, then the last 4 chars
    // of the suffix.
    if let Some((head, suffix)) = split_head_suffix(raw) {
        if suffix.len() >= 4 {
            let last4 = &suffix[suffix.len() - 4..];
            return format!("{head}_{}…{last4}", &suffix[..suffix.len().min(2)]);
        }
        return format!("{head}_{suffix}");
    }
    // Legacy / unrecognised format: surface a defensive truncation rather
    // than echoing the full secret.
    let truncated = raw.chars().take(8).collect::<String>();
    format!("{truncated}…")
}

fn split_head_suffix(raw: &str) -> Option<(String, &str)> {
    let parts: Vec<&str> = raw.splitn(4, '_').collect();
    if parts.len() == 4 && parts[0] == PREFIX {
        let head = format!("{}_{}_{}", parts[0], parts[1], parts[2]);
        Some((head, parts[3]))
    } else {
        None
    }
}

fn encode_base62(bytes: &[u8]) -> String {
    // Standard base62 of arbitrary bytes via repeated division. The
    // suffix length depends on input bytes; for 32 bytes we land on
    // ~43 characters.
    let mut digits: Vec<u8> = Vec::with_capacity(bytes.len() * 2);
    for &b in bytes {
        let mut carry = b as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) * 256;
            *d = (carry % 62) as u8;
            carry /= 62;
        }
        while carry > 0 {
            digits.push((carry % 62) as u8);
            carry /= 62;
        }
    }
    // Preserve leading zero bytes as leading '0' characters.
    for &b in bytes {
        if b == 0 {
            digits.push(0);
        } else {
            break;
        }
    }
    digits
        .iter()
        .rev()
        .map(|&d| BASE62[d as usize] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_key_round_trip() {
        let g = generate(KeyType::Sk, Environment::Live);
        assert!(g.raw.starts_with("owlid_sk_live_"));
        assert!(g.preview.starts_with("owlid_sk_live_"));
        assert!(g.preview.contains('…'));
        assert_ne!(g.raw, g.preview);
    }

    #[test]
    fn preview_handles_legacy_format() {
        let p = preview_for("dev_key_12345678901234567890");
        assert!(p.ends_with('…'));
        assert!(!p.contains("345678901234567890"));
    }

    #[test]
    fn base62_alphabet_only() {
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let s = encode_base62(&bytes);
        for c in s.chars() {
            assert!(c.is_ascii_alphanumeric());
        }
    }
}
