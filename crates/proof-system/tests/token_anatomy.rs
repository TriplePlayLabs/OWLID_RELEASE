//! Token anatomy — break down exactly where every byte goes.
//! Run: cargo test --package owl-proof-system --test token_anatomy -- --nocapture

use owl_crypto::KeyPair;
use owl_proof_system::document::Document;
use owl_proof_system::{PredicateOp, PredicateRequest, ProofRequest, Token};
use serde_json::json;
use std::collections::BTreeMap;

fn token_to_cbor_bytes(token: &Token) -> Vec<u8> {
    let compact = token.to_compact().unwrap();
    let b45 = compact.strip_prefix("OID1:").unwrap();
    base45::decode(b45).unwrap()
}

/// Parse CBOR and print field-by-field sizes
fn analyze_cbor(cbor_bytes: &[u8]) {
    let cbor: ciborium::Value = ciborium::from_reader(cbor_bytes).unwrap();

    if let ciborium::Value::Map(entries) = &cbor {
        let mut field_sizes: Vec<(String, usize)> = Vec::new();
        let mut total_overhead = 0usize;

        for (k, v) in entries {
            let key_int = match k {
                ciborium::Value::Integer(i) => {
                    let n: i128 = (*i).into();
                    n as i64
                }
                _ => -1,
            };

            let field_name = match key_int {
                0 => "version",
                1 => "challenge",
                2 => "root_hash",
                3 => "issuer_signature",
                4 => "merkle_proof",
                5 => "subjects",
                6 => "ttl",
                7 => "activation_time",
                8 => "salt",
                9 => "signers",
                10 => "signer_threshold",
                11 => "zk_proofs",
                12 => "committed_attributes",
                13 => "owner_signature",
                15 => "hmac",
                _ => "unknown",
            };

            // Serialize just this value to measure its byte size
            let mut val_bytes = Vec::new();
            ciborium::into_writer(v, &mut val_bytes).unwrap();

            // Key overhead: 1 byte for int keys 0-23
            let key_overhead = 1;
            total_overhead += key_overhead;

            field_sizes.push((format!("[{:>2}] {}", key_int, field_name), val_bytes.len()));

            // Drill into complex fields
            match key_int {
                3 => {
                    // issuer_signature: [algo, bytes]
                    if let ciborium::Value::Array(arr) = v {
                        for (i, item) in arr.iter().enumerate() {
                            let mut b = Vec::new();
                            ciborium::into_writer(item, &mut b).unwrap();
                            let sub = match i {
                                0 => "  algo",
                                1 => "  sig_bytes",
                                _ => "  ?",
                            };
                            println!("       {:<35} {:>6} bytes", sub, b.len());
                        }
                    }
                }
                4 => {
                    // merkle_proof: {0: root, 1: leaves, 2: siblings}
                    if let ciborium::Value::Map(mp) = v {
                        for (mk, mv) in mp {
                            let mut b = Vec::new();
                            ciborium::into_writer(mv, &mut b).unwrap();
                            let mk_int = match mk {
                                ciborium::Value::Integer(i) => { let n: i128 = (*i).into(); n as i64 }
                                _ => -1,
                            };
                            let sub = match mk_int {
                                0 => "  root_hash (dup of field 2!)",
                                1 => "  proof_leaves",
                                2 => "  siblings_packed",
                                _ => "  ?",
                            };
                            println!("       {:<35} {:>6} bytes", sub, b.len());

                            // Drill into leaves
                            if mk_int == 1 {
                                if let ciborium::Value::Array(leaves) = mv {
                                    for (li, leaf) in leaves.iter().enumerate() {
                                        let mut lb = Vec::new();
                                        ciborium::into_writer(leaf, &mut lb).unwrap();
                                        if let ciborium::Value::Array(la) = leaf {
                                            let key_str = match &la[0] {
                                                ciborium::Value::Text(s) => s.clone(),
                                                _ => "?".into(),
                                            };
                                            let hash_len = match &la[1] {
                                                ciborium::Value::Bytes(b) => b.len(),
                                                _ => 0,
                                            };
                                            println!("         leaf[{}]: key=\"{}\" ({}B) + hash ({}B) + pos = {}B total",
                                                li, key_str, key_str.len(), hash_len, lb.len());
                                        }
                                    }
                                }
                            }

                            // Drill into siblings
                            if mk_int == 2 {
                                if let ciborium::Value::Array(arr) = mv {
                                    if arr.len() == 2 {
                                        let hash_len = match &arr[0] {
                                            ciborium::Value::Bytes(b) => b.len(),
                                            _ => 0,
                                        };
                                        let meta_len = match &arr[1] {
                                            ciborium::Value::Bytes(b) => b.len(),
                                            _ => 0,
                                        };
                                        let n_siblings = meta_len;
                                        println!("         {} siblings: {}B hashes + {}B meta",
                                            n_siblings, hash_len, meta_len);
                                    }
                                }
                            }
                        }
                    }
                }
                5 => {
                    // subjects
                    if let ciborium::Value::Map(subj) = v {
                        for (sk, sv) in subj {
                            let mut b = Vec::new();
                            ciborium::into_writer(sv, &mut b).unwrap();
                            let key_str = match sk {
                                ciborium::Value::Text(s) => s.clone(),
                                _ => "?".into(),
                            };
                            let val_desc = match sv {
                                ciborium::Value::Text(s) => format!("text({})", s.len()),
                                ciborium::Value::Bytes(b) => format!("bytes({})", b.len()),
                                ciborium::Value::Integer(_) => "int".into(),
                                ciborium::Value::Bool(_) => "bool".into(),
                                _ => "other".into(),
                            };
                            println!("       {:<35} {:>6} bytes  [key=\"{}\" ({}B), val={}]",
                                format!("  {}", key_str), b.len() + key_str.len() + 1,
                                key_str, key_str.len(), val_desc);
                        }
                    }
                }
                9 => {
                    // signers
                    if let ciborium::Value::Array(arr) = v {
                        for (i, item) in arr.iter().enumerate() {
                            let mut b = Vec::new();
                            ciborium::into_writer(item, &mut b).unwrap();
                            println!("       {:<35} {:>6} bytes",
                                format!("  signer[{}]", i), b.len());
                        }
                    }
                }
                11 => {
                    // zk_proofs
                    if let ciborium::Value::Array(proofs) = v {
                        for (pi, proof) in proofs.iter().enumerate() {
                            let mut pb = Vec::new();
                            ciborium::into_writer(proof, &mut pb).unwrap();
                            println!("       {:<35} {:>6} bytes", format!("  zk_proof[{}]", pi), pb.len());

                            if let ciborium::Value::Map(pm) = proof {
                                for (pk, pv) in pm {
                                    let mut fb = Vec::new();
                                    ciborium::into_writer(pv, &mut fb).unwrap();
                                    let pk_int = match pk {
                                        ciborium::Value::Integer(i) => { let n: i128 = (*i).into(); n as i64 }
                                        _ => -1,
                                    };
                                    let sub = match pk_int {
                                        0 => "    proof_type",
                                        1 => "    proof_bytes",
                                        2 => "    public_inputs",
                                        3 => "    bound_attribute",
                                        4 => "    attr_leaf_hash",
                                        _ => "    ?",
                                    };
                                    println!("         {:<33} {:>6} bytes", sub, fb.len());
                                }
                            }
                        }
                    }
                }
                13 => {
                    // owner_signature
                    if let ciborium::Value::Array(arr) = v {
                        let tag = match &arr[0] {
                            ciborium::Value::Integer(i) => { let n: i128 = (*i).into(); n as i64 }
                            _ => -1,
                        };
                        let sig_type = match tag {
                            0 => "Standard",
                            1 => "WebAuthn",
                            2 => "RingSig",
                            _ => "Unknown",
                        };
                        println!("       type: {}", sig_type);
                        for (i, item) in arr.iter().enumerate() {
                            let mut b = Vec::new();
                            ciborium::into_writer(item, &mut b).unwrap();
                            println!("       {:<35} {:>6} bytes",
                                format!("  element[{}]", i), b.len());
                        }
                    }
                }
                _ => {}
            }
        }

        println!("\n  === Field Size Summary ===");
        let mut total_value_bytes = 0usize;
        for (name, size) in &field_sizes {
            println!("  {:<40} {:>6} bytes", name, size);
            total_value_bytes += size;
        }
        println!("  {:<40} {:>6} bytes", "Map key overhead (1B each)", entries.len());
        println!("  {:<40} {:>6} bytes", "CBOR map header", cbor_bytes.len() - total_value_bytes - entries.len());
        println!("  {:<40} {:>6} bytes", "TOTAL", cbor_bytes.len());

        // Identify savings opportunities
        println!("\n  === Savings Opportunities ===");

        // 1. Duplicate root hash
        let root_hash_size = field_sizes.iter()
            .find(|(n, _)| n.contains("root_hash"))
            .map(|(_, s)| *s)
            .unwrap_or(0);
        if field_sizes.iter().any(|(n, _)| n.contains("merkle_proof")) {
            println!("  [DUP] root_hash in field 2 AND merkle_proof.0: save ~{} bytes", root_hash_size);
        }

        // 2. Signers that duplicate subjects
        let signers_size = field_sizes.iter()
            .find(|(n, _)| n.contains("signers"))
            .map(|(_, s)| *s)
            .unwrap_or(0);
        if signers_size > 0 {
            println!("  [DUP] signers duplicates issuerKey/ownerKey from subjects: save ~{} bytes", signers_size);
        }

        // 3. Challenge string — could use shorter format
        if let Some((_, challenge_size)) = field_sizes.iter().find(|(n, _)| n.contains("challenge")) {
            println!("  [OPT] challenge is {} bytes — could use 16-byte random + CBOR bytes instead of UUID string", challenge_size);
        }

        // 4. String attribute keys in subjects
        println!("  [OPT] Subject keys are full strings — could use integer indices with shared schema");

        // 5. version field
        println!("  [OPT] version=1 always present — could be implicit in prefix");

        // 6. signer_threshold=1
        let threshold_size = field_sizes.iter()
            .find(|(n, _)| n.contains("signer_threshold"))
            .map(|(_, s)| *s)
            .unwrap_or(0);
        if threshold_size > 0 {
            println!("  [OPT] signer_threshold=1 (default) — omit when default, save {} bytes", threshold_size + 1);
        }

        // 7. ttl as delta
        println!("  [OPT] ttl + activation_time: if ttl is standard (3600), omit and use default");
    }
}

#[test]
fn token_anatomy_simple() {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();

    let mut attrs = BTreeMap::new();
    attrs.insert("issuerKey".into(), json!(issuer.public_key().to_hex()));
    attrs.insert("ownerKey".into(), json!(owner.public_key().to_hex()));
    attrs.insert("name".into(), json!("Jane Doe"));
    attrs.insert("dateOfBirth".into(), json!("1994-06-15"));

    let doc = Document::new(attrs).unwrap();
    let mut pd = doc.issue(&issuer);

    let req = ProofRequest {
        disclose: vec!["name".into()],
        predicates: vec![],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "ch-9f2e7a1b-4c3d-4e8f-a1b2-c3d4e5f6a7b8".into(),
    };
    let token = Token::generate(&mut pd, &req, &owner, 3600).unwrap();
    let cbor = token_to_cbor_bytes(&token);

    println!("\n{}", "=".repeat(80));
    println!("  SIMPLE TOKEN ANATOMY ({} CBOR bytes, {} Base45 chars)",
        cbor.len(), token.to_compact().unwrap().len());
    println!("{}", "=".repeat(80));
    analyze_cbor(&cbor);
}

#[test]
fn token_anatomy_medium() {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();

    let mut attrs = BTreeMap::new();
    attrs.insert("issuerKey".into(), json!(issuer.public_key().to_hex()));
    attrs.insert("ownerKey".into(), json!(owner.public_key().to_hex()));
    attrs.insert("givenName".into(), json!("Alexandra"));
    attrs.insert("familyName".into(), json!("Papadopoulos"));
    attrs.insert("dateOfBirth".into(), json!("1990-03-22"));
    attrs.insert("nationality".into(), json!("GR"));
    attrs.insert("documentNumber".into(), json!("AB1234567"));
    attrs.insert("expiryDate".into(), json!("2029-12-31"));

    let doc = Document::new(attrs).unwrap();
    let mut pd = doc.issue(&issuer);

    let req = ProofRequest {
        disclose: vec!["givenName".into(), "familyName".into(), "nationality".into()],
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".into(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "ch-a1b2c3d4-e5f6-7890-abcd-ef1234567890".into(),
    };
    let token = Token::generate(&mut pd, &req, &owner, 7200).unwrap();
    let cbor = token_to_cbor_bytes(&token);

    println!("\n{}", "=".repeat(80));
    println!("  MEDIUM TOKEN ANATOMY ({} CBOR bytes, {} Base45 chars)",
        cbor.len(), token.to_compact().unwrap().len());
    println!("{}", "=".repeat(80));
    analyze_cbor(&cbor);
}

#[test]
fn token_anatomy_heavy() {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();

    let mut attrs = BTreeMap::new();
    attrs.insert("issuerKey".into(), json!(issuer.public_key().to_hex()));
    attrs.insert("ownerKey".into(), json!(owner.public_key().to_hex()));
    attrs.insert("givenName".into(), json!("Konstantinos"));
    attrs.insert("familyName".into(), json!("Papadopoulos"));
    attrs.insert("dateOfBirth".into(), json!("1988-11-05"));
    attrs.insert("nationality".into(), json!("GR"));
    attrs.insert("documentNumber".into(), json!("XY9876543"));
    attrs.insert("expiryDate".into(), json!("2030-06-30"));
    attrs.insert("issuingAuthority".into(), json!("Hellenic Police"));
    attrs.insert("address".into(), json!("123 Ermou Street, Athens 10563"));
    attrs.insert("verificationLevel".into(), json!(3));
    attrs.insert("kycProvider".into(), json!("VeriffPrime"));

    let doc = Document::new(attrs).unwrap();
    let mut pd = doc.issue(&issuer);

    let req = ProofRequest {
        disclose: vec![
            "givenName".into(), "familyName".into(),
            "nationality".into(), "issuingAuthority".into(),
        ],
        predicates: vec![
            PredicateRequest {
                attribute: "dateOfBirth".into(),
                op: PredicateOp::GreaterOrEqual,
                value: json!(18),
            },
            PredicateRequest {
                attribute: "verificationLevel".into(),
                op: PredicateOp::GreaterOrEqual,
                value: json!(2),
            },
        ],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "ch-deadbeef-cafe-babe-1234-567890abcdef".into(),
    };
    let token = Token::generate(&mut pd, &req, &owner, 3600).unwrap();
    let cbor = token_to_cbor_bytes(&token);

    println!("\n{}", "=".repeat(80));
    println!("  HEAVY TOKEN ANATOMY ({} CBOR bytes, {} Base45 chars)",
        cbor.len(), token.to_compact().unwrap().len());
    println!("{}", "=".repeat(80));
    analyze_cbor(&cbor);

    // Also show what optimal packing could look like
    println!("\n{}", "=".repeat(80));
    println!("  ESTIMATED SAVINGS FROM STRUCTURAL OPTIMIZATIONS");
    println!("{}", "=".repeat(80));

    let current = cbor.len();
    let mut savings = Vec::new();

    // Savings calculations
    savings.push(("Remove dup root_hash from merkle_proof", 34)); // 32 bytes + 2 CBOR overhead
    savings.push(("Remove signers (derive from subjects)", 69)); // 2x33 + array overhead
    savings.push(("Challenge: UUID string -> 16 raw bytes", 26)); // 42-char string vs 18-byte bstr
    savings.push(("Omit version (implicit in NID prefix)", 2));
    savings.push(("Omit signer_threshold=1 (default)", 2));
    savings.push(("Subject keys: string -> int index", 45)); // ~8 chars avg * 5 keys + overhead
    savings.push(("Omit ttl=3600 (default)", 4));
    savings.push(("Merkle leaf keys: string -> int index", 30)); // same as above for leaf keys
    savings.push(("ZK bound_attribute: string -> int index", 15));

    let mut total_savings = 0;
    for (desc, bytes) in &savings {
        println!("  {:>4}B  {}", bytes, desc);
        total_savings += bytes;
    }
    println!("  ----");
    println!("  {:>4}B  TOTAL structural savings", total_savings);
    println!();
    println!("  Current CBOR:      {:>5} bytes -> {:>5} Base45 chars", current, current * 3 / 2);
    let optimized = current - total_savings;
    println!("  After structural:  {:>5} bytes -> {:>5} Base45 chars", optimized, optimized * 3 / 2);
    let with_zstd = (optimized as f64 * 0.62) as usize; // dict compression ratio
    println!("  + zstd+dict:       {:>5} bytes -> {:>5} Base45 chars", with_zstd, with_zstd * 3 / 2);
    println!();
    println!("  Overall reduction: {} -> {} chars ({:.0}% smaller)",
        current * 3 / 2, with_zstd * 3 / 2,
        (1.0 - with_zstd as f64 / current as f64) * 100.0);
}
