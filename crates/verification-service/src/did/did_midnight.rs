//! `did:midnight` resolver — STUB (intentional).
//!
//! Spec status: **`did:midnight` v0.3 draft** (Midnight Foundation +
//! IAMX + Identus, private repo `midnightntwrk/midnight-did`). The
//! repo carries the W3C-compliant method spec, the Compact contract,
//! and a TypeScript reference implementation. **No Rust resolver
//! exists upstream** (spec §7.2.2 mentions one as future work).
//!
//! Syntax (spec §2):
//! ```text
//!   did:midnight:<network>:<68-hex>
//!   network = "undeployed" | "devnet" | "testnet" | "mainnet"
//!   address = 68 hex chars (Midnight ContractAddress + segment prefix)
//! ```
//!
//! Resolution flow (spec §7.2):
//!   1. Parse identifier → (network, contract_address)
//!   2. Attach to the deployed `did:midnight` contract at that address
//!      via the Midnight JS library OR the Midnight Indexer GraphQL.
//!   3. Read on-chain ledger state (see spec §6 — controllerPublicKey,
//!      verificationMethods, *Relation sets, services, alsoKnownAs,
//!      version, created, updated, deactivated).
//!   4. Reconstruct the DID Document (verificationMethod with
//!      `type: JsonWebKey`, `publicKeyJwk` for Ed25519 / JubJub / P-256).
//!
//! Integration blockers (audited 2026-05-20):
//!   * The upstream `@midnight-ntwrk/midnight-did-api` package pins
//!     `@midnight-ntwrk/midnight-js-contracts: 2.0.1` while the OwlID
//!     sidecar runs `4.0.4` — direct npm consumption is not safe.
//!   * The lighter `@midnight-ntwrk/midnight-did-contract` and
//!     `@midnight-ntwrk/midnight-did` packages are slimmer (only depend
//!     on `compact-runtime`) but their Compact source uses
//!     `pragma language_version 0.18`, which requires Compact compiler
//!     >= 0.26.0 to build locally.
//!   * The packages are not yet published to a public npm registry;
//!     consumption requires `npm pack` tarballs or workspace cloning.
//!
//! Path forward (when chosen):
//!   1. Sidecar (`packages/midnight-sidecar/`) wraps the on-chain read
//!      using its existing `midnight-js` providers and exposes
//!      `GET /api/dids/{did}/document` that returns a DID Document JSON.
//!   2. This module proxies to that sidecar route.
//!   3. Anchor check (`did/mod.rs::anchor_check`) becomes a no-op for
//!      `did:midnight` because the document IS the on-chain state — no
//!      separate hashlink commitment needed.
//!
//! Until that lands, this resolver returns a structured error that
//! confirms the DID syntax is valid (so callers can distinguish a
//! malformed DID from a spec-known but not-yet-wired one).

use super::{DidMethodResolver, ResolvedDid};
use async_trait::async_trait;

pub struct DidMidnightResolver;

#[async_trait]
impl DidMethodResolver for DidMidnightResolver {
    fn method(&self) -> &'static str {
        "midnight"
    }

    async fn resolve(&self, did: &str) -> Result<ResolvedDid, String> {
        validate_syntax(did)?;
        Err(format!(
            "did:midnight resolver not yet wired to the chain (syntax-valid {did}). \
             Upstream reference impl is TypeScript-only and pins midnight-js v2.0.1 \
             while OwlID's sidecar runs v4.0.4 — see STANDARDS.md §10 for the path forward."
        ))
    }
}

/// Validate the spec-defined Midnight DID syntax:
///   `did:midnight:<network>:<68 hex>` where network ∈
///   {undeployed, devnet, testnet, mainnet}.
pub fn validate_syntax(did: &str) -> Result<(MidnightNetwork, String), String> {
    let rest = did
        .strip_prefix("did:midnight:")
        .ok_or_else(|| format!("not a did:midnight: {did}"))?;
    let mut parts = rest.splitn(2, ':');
    let network = parts
        .next()
        .ok_or_else(|| "did:midnight missing network segment".to_string())?;
    let address = parts
        .next()
        .ok_or_else(|| "did:midnight missing contract address".to_string())?;
    let network = MidnightNetwork::parse(network)
        .ok_or_else(|| format!("did:midnight unknown network: {network}"))?;
    if address.len() != 68 {
        return Err(format!(
            "did:midnight contract address must be 68 hex chars (got {})",
            address.len()
        ));
    }
    if !address.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("did:midnight contract address must be hex".to_string());
    }
    Ok((network, address.to_string()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MidnightNetwork {
    Undeployed,
    DevNet,
    Testnet,
    Mainnet,
}

impl MidnightNetwork {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "undeployed" => Some(Self::Undeployed),
            "devnet" => Some(Self::DevNet),
            "testnet" => Some(Self::Testnet),
            "mainnet" => Some(Self::Mainnet),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn returns_structured_error_with_path_forward_reference() {
        let did = "did:midnight:undeployed:\
                   02007dd39c6606563dd043f06a94f60659b00d4d4ff6a65d2db4ddbc277956c13aa3";
        let err = DidMidnightResolver.resolve(did).await.unwrap_err();
        assert!(err.contains("not yet wired"));
        assert!(err.contains("STANDARDS.md"));
    }

    #[test]
    fn syntax_validates_spec_example() {
        let did = "did:midnight:undeployed:\
                   02007dd39c6606563dd043f06a94f60659b00d4d4ff6a65d2db4ddbc277956c13aa3";
        let (net, addr) = validate_syntax(did).unwrap();
        assert_eq!(net, MidnightNetwork::Undeployed);
        assert_eq!(addr.len(), 68);
    }

    #[test]
    fn syntax_accepts_all_four_networks() {
        for net in ["undeployed", "devnet", "testnet", "mainnet"] {
            let did = format!("did:midnight:{net}:{}", "0".repeat(68));
            assert!(validate_syntax(&did).is_ok(), "{net}");
        }
    }

    #[test]
    fn syntax_rejects_unknown_network() {
        let did = format!("did:midnight:goerli:{}", "0".repeat(68));
        let err = validate_syntax(&did).unwrap_err();
        assert!(err.contains("unknown network"));
    }

    #[test]
    fn syntax_rejects_short_address() {
        let did = "did:midnight:undeployed:abcdef";
        let err = validate_syntax(did).unwrap_err();
        assert!(err.contains("68 hex"));
    }

    #[test]
    fn syntax_rejects_non_hex_address() {
        let did = format!("did:midnight:undeployed:{}", "z".repeat(68));
        let err = validate_syntax(&did).unwrap_err();
        assert!(err.contains("must be hex"));
    }

    #[test]
    fn syntax_rejects_non_did_midnight() {
        assert!(validate_syntax("did:web:issuer.example").is_err());
        assert!(validate_syntax("").is_err());
    }
}
