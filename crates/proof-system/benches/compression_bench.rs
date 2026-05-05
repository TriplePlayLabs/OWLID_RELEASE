//! Compression benchmark for QR token encoding.
//!
//! Tests various compression + encoding pipelines against realistic token payloads.
//! Run with: cargo test --package owl-proof-system --test compression_bench -- --nocapture

use owl_crypto::KeyPair;
use owl_proof_system::document::Document;
use owl_proof_system::{PredicateOp, PredicateRequest, ProofRequest, Token};
use serde_json::json;
use std::collections::BTreeMap;
use std::io::{Read, Write};

// ---------------------------------------------------------------------------
// QR capacity constants
// ---------------------------------------------------------------------------
const QR_V40_L_ALNUM: usize = 4_296;
const QR_V40_L_BYTE: usize = 2_953;
const QR_V30_L_ALNUM: usize = 2_520;

// ---------------------------------------------------------------------------
// Token builders — realistic payloads at different sizes
// ---------------------------------------------------------------------------

fn build_simple_token() -> Token {
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
    Token::generate(&mut pd, &req, &owner, 3600).unwrap()
}

fn build_medium_token() -> Token {
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
        disclose: vec![
            "givenName".into(),
            "familyName".into(),
            "nationality".into(),
        ],
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".into(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "ch-a1b2c3d4-e5f6-7890-abcd-ef1234567890".into(),
    };
    Token::generate(&mut pd, &req, &owner, 7200).unwrap()
}

fn build_heavy_token() -> Token {
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
            "givenName".into(),
            "familyName".into(),
            "nationality".into(),
            "issuingAuthority".into(),
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
    Token::generate(&mut pd, &req, &owner, 3600).unwrap()
}

// ---------------------------------------------------------------------------
// Compression helpers
// ---------------------------------------------------------------------------

fn compress_zlib(data: &[u8], level: u32) -> Vec<u8> {
    let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::new(level));
    enc.write_all(data).unwrap();
    enc.finish().unwrap()
}

fn decompress_zlib(data: &[u8]) -> Vec<u8> {
    let mut dec = flate2::read::DeflateDecoder::new(data);
    let mut out = Vec::new();
    dec.read_to_end(&mut out).unwrap();
    out
}

fn compress_zstd(data: &[u8], level: i32) -> Vec<u8> {
    zstd::encode_all(data, level).unwrap()
}

fn decompress_zstd(data: &[u8]) -> Vec<u8> {
    zstd::decode_all(data).unwrap()
}

fn compress_zstd_dict(data: &[u8], level: i32, dict: &[u8]) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut enc = zstd::Encoder::with_dictionary(&mut buf, level, dict).unwrap();
    enc.write_all(data).unwrap();
    enc.finish().unwrap();
    buf
}

fn decompress_zstd_dict(data: &[u8], dict: &[u8]) -> Vec<u8> {
    let mut dec = zstd::Decoder::with_dictionary(data, dict).unwrap();
    let mut out = Vec::new();
    dec.read_to_end(&mut out).unwrap();
    out
}

fn compress_brotli(data: &[u8], quality: u32) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut enc = brotli::CompressorWriter::new(&mut out, 4096, quality, 22);
        enc.write_all(data).unwrap();
    }
    out
}

fn decompress_brotli(data: &[u8]) -> Vec<u8> {
    let mut dec = brotli::Decompressor::new(data, 4096);
    let mut out = Vec::new();
    dec.read_to_end(&mut out).unwrap();
    out
}

fn compress_lz4(data: &[u8]) -> Vec<u8> {
    lz4_flex::compress_prepend_size(data)
}

fn decompress_lz4(data: &[u8]) -> Vec<u8> {
    lz4_flex::decompress_size_prepended(data).unwrap()
}

// ---------------------------------------------------------------------------
// Pipeline helpers
// ---------------------------------------------------------------------------

/// Current pipeline: CBOR -> Base45 -> OID1:
fn pipeline_current(token: &Token) -> String {
    token.to_compact().unwrap()
}

/// CBOR -> zlib -> Base45 -> OID1:
fn pipeline_zlib(cbor: &[u8]) -> String {
    let compressed = compress_zlib(cbor, 6);
    format!("OID1:{}", base45::encode(&compressed))
}

/// CBOR -> zstd -> Base45 -> NID3:
fn pipeline_zstd(cbor: &[u8], level: i32) -> String {
    let compressed = compress_zstd(cbor, level);
    format!("NID3:{}", base45::encode(&compressed))
}

/// CBOR -> zstd+dict -> Base45 -> NID4:
fn pipeline_zstd_dict(cbor: &[u8], level: i32, dict: &[u8]) -> String {
    let compressed = compress_zstd_dict(cbor, level, dict);
    format!("NID4:{}", base45::encode(&compressed))
}

/// CBOR -> brotli -> Base45 -> NID5:
fn pipeline_brotli(cbor: &[u8], quality: u32) -> String {
    let compressed = compress_brotli(cbor, quality);
    format!("NID5:{}", base45::encode(&compressed))
}

/// CBOR -> lz4 -> Base45 -> NID6:
fn pipeline_lz4(cbor: &[u8]) -> String {
    let compressed = compress_lz4(cbor);
    format!("NID6:{}", base45::encode(&compressed))
}

/// CBOR -> zlib -> raw binary (QR byte mode)
fn pipeline_zlib_binary(cbor: &[u8]) -> Vec<u8> {
    compress_zlib(cbor, 6)
}

/// CBOR -> zstd -> raw binary (QR byte mode)
fn pipeline_zstd_binary(cbor: &[u8], level: i32) -> Vec<u8> {
    compress_zstd(cbor, level)
}

// ---------------------------------------------------------------------------
// Dictionary training from sample tokens
// ---------------------------------------------------------------------------

fn train_dictionary(tokens: &[Token]) -> Vec<u8> {
    let samples: Vec<Vec<u8>> = tokens
        .iter()
        .map(|t| {
            let cbor = token_to_cbor_bytes(t);
            cbor
        })
        .collect();

    let sample_refs: Vec<&[u8]> = samples.iter().map(|s| s.as_slice()).collect();
    // Train a 4KB dictionary
    zstd::dict::from_samples(&sample_refs, 4096).unwrap_or_else(|_| {
        // Fallback: use concatenation of samples as dictionary
        samples.concat()
    })
}

fn token_to_cbor_bytes(token: &Token) -> Vec<u8> {
    // Get compact string and extract CBOR bytes
    let compact = token.to_compact().unwrap();
    let b45 = compact.strip_prefix("OID1:").unwrap();
    base45::decode(b45).unwrap()
}

// ---------------------------------------------------------------------------
// Roundtrip verification
// ---------------------------------------------------------------------------

fn verify_roundtrip_zlib(cbor: &[u8]) {
    let compressed = compress_zlib(cbor, 6);
    let decompressed = decompress_zlib(&compressed);
    assert_eq!(cbor, &decompressed[..], "zlib roundtrip failed");
}

fn verify_roundtrip_zstd(cbor: &[u8]) {
    let compressed = compress_zstd(cbor, 3);
    let decompressed = decompress_zstd(&compressed);
    assert_eq!(cbor, &decompressed[..], "zstd roundtrip failed");
}

fn verify_roundtrip_brotli(cbor: &[u8]) {
    let compressed = compress_brotli(cbor, 6);
    let decompressed = decompress_brotli(&compressed);
    assert_eq!(cbor, &decompressed[..], "brotli roundtrip failed");
}

fn verify_roundtrip_lz4(cbor: &[u8]) {
    let compressed = compress_lz4(cbor);
    let decompressed = decompress_lz4(&compressed);
    assert_eq!(cbor, &decompressed[..], "lz4 roundtrip failed");
}

fn verify_roundtrip_zstd_dict(cbor: &[u8], dict: &[u8]) {
    let compressed = compress_zstd_dict(cbor, 3, dict);
    let decompressed = decompress_zstd_dict(&compressed, dict);
    assert_eq!(cbor, &decompressed[..], "zstd+dict roundtrip failed");
}

// ---------------------------------------------------------------------------
// Main benchmark
// ---------------------------------------------------------------------------

#[test]
fn compression_benchmark() {
    println!("\n{}", "=".repeat(80));
    println!("  OWL ID Token Compression Benchmark");
    println!("  QR v40-L alphanumeric: {} chars | byte mode: {} bytes",
        QR_V40_L_ALNUM, QR_V40_L_BYTE);
    println!("  QR v30-L alphanumeric: {} chars", QR_V30_L_ALNUM);
    println!("{}", "=".repeat(80));

    // Build test tokens
    let simple = build_simple_token();
    let medium = build_medium_token();
    let heavy = build_heavy_token();

    // Train dictionary from a corpus of sample tokens
    let dict_corpus: Vec<Token> = (0..20)
        .map(|i| {
            if i % 3 == 0 { build_simple_token() }
            else if i % 3 == 1 { build_medium_token() }
            else { build_heavy_token() }
        })
        .collect();
    let dict = train_dictionary(&dict_corpus);
    println!("\nTrained zstd dictionary: {} bytes from {} sample tokens\n", dict.len(), dict_corpus.len());

    let scenarios: Vec<(&str, Token)> = vec![
        ("Simple (1 disclosed, 0 ZK)", simple),
        ("Medium (3 disclosed, 1 ZK)", medium),
        ("Heavy  (4 disclosed, 2 ZK)", heavy),
    ];

    for (label, token) in &scenarios {
        let cbor = token_to_cbor_bytes(token);
        let current = pipeline_current(token);

        // Verify all roundtrips
        verify_roundtrip_zlib(&cbor);
        verify_roundtrip_zstd(&cbor);
        verify_roundtrip_brotli(&cbor);
        verify_roundtrip_lz4(&cbor);
        verify_roundtrip_zstd_dict(&cbor, &dict);

        println!("{}", "-".repeat(80));
        println!("  {}", label);
        println!("  CBOR size: {} bytes | Current Base45: {} chars", cbor.len(), current.len());
        println!("{}", "-".repeat(80));
        println!("{:<42} {:>8} {:>8} {:>9} {:>6}",
            "Pipeline", "Encoded", "Binary", "Savings", "Fits?");
        println!("{:<42} {:>8} {:>8} {:>9} {:>6}",
            "", "chars", "bytes", "vs curr", "V40-L");

        // 1. Current: CBOR + Base45
        print_row("CBOR + Base45 (current)", current.len(), cbor.len(), current.len());

        // 2. CBOR + zlib(6) + Base45
        let r = pipeline_zlib(&cbor);
        let bin = pipeline_zlib_binary(&cbor);
        print_row("CBOR + zlib(6) + Base45", r.len(), bin.len(), current.len());

        // 3. CBOR + zlib(9) + Base45
        let z9 = compress_zlib(&cbor, 9);
        let r9 = format!("OID1:{}", base45::encode(&z9));
        print_row("CBOR + zlib(9) + Base45", r9.len(), z9.len(), current.len());

        // 4. CBOR + zstd(1) + Base45
        let r = pipeline_zstd(&cbor, 1);
        let bin = pipeline_zstd_binary(&cbor, 1);
        print_row("CBOR + zstd(1) + Base45", r.len(), bin.len(), current.len());

        // 5. CBOR + zstd(3) + Base45
        let r = pipeline_zstd(&cbor, 3);
        let bin = pipeline_zstd_binary(&cbor, 3);
        print_row("CBOR + zstd(3) + Base45", r.len(), bin.len(), current.len());

        // 6. CBOR + zstd(9) + Base45
        let r = pipeline_zstd(&cbor, 9);
        let bin = pipeline_zstd_binary(&cbor, 9);
        print_row("CBOR + zstd(9) + Base45", r.len(), bin.len(), current.len());

        // 7. CBOR + zstd(3)+dict + Base45
        let r = pipeline_zstd_dict(&cbor, 3, &dict);
        let zd = compress_zstd_dict(&cbor, 3, &dict);
        print_row("CBOR + zstd(3)+dict + Base45", r.len(), zd.len(), current.len());

        // 8. CBOR + zstd(9)+dict + Base45
        let r = pipeline_zstd_dict(&cbor, 9, &dict);
        let zd = compress_zstd_dict(&cbor, 9, &dict);
        print_row("CBOR + zstd(9)+dict + Base45", r.len(), zd.len(), current.len());

        // 9. CBOR + zstd(19)+dict + Base45
        let r = pipeline_zstd_dict(&cbor, 19, &dict);
        let zd = compress_zstd_dict(&cbor, 19, &dict);
        print_row("CBOR + zstd(19)+dict + Base45", r.len(), zd.len(), current.len());

        // 10. CBOR + brotli(6) + Base45
        let r = pipeline_brotli(&cbor, 6);
        let br = compress_brotli(&cbor, 6);
        print_row("CBOR + brotli(6) + Base45", r.len(), br.len(), current.len());

        // 11. CBOR + brotli(11) + Base45
        let r = pipeline_brotli(&cbor, 11);
        let br = compress_brotli(&cbor, 11);
        print_row("CBOR + brotli(11) + Base45", r.len(), br.len(), current.len());

        // 12. CBOR + lz4 + Base45
        let r = pipeline_lz4(&cbor);
        let l4 = compress_lz4(&cbor);
        print_row("CBOR + lz4 + Base45", r.len(), l4.len(), current.len());

        // 13. Raw binary mode (no base45): CBOR + zstd(3)
        let bin = pipeline_zstd_binary(&cbor, 3);
        print_row_binary("CBOR + zstd(3) [binary QR]", bin.len());

        // 14. Raw binary mode: CBOR + zstd(3)+dict
        let zd = compress_zstd_dict(&cbor, 3, &dict);
        print_row_binary("CBOR + zstd(3)+dict [binary QR]", zd.len());

        // 15. Raw binary mode: CBOR only (no compression)
        print_row_binary("CBOR only [binary QR]", cbor.len());

        println!();

        // Breakdown: what's compressible?
        println!("  Compression analysis:");
        let zstd3 = compress_zstd(&cbor, 3);
        let ratio = (zstd3.len() as f64 / cbor.len() as f64) * 100.0;
        println!("    zstd(3) ratio: {:.1}% ({} -> {} bytes, delta {} bytes)",
            ratio, cbor.len(), zstd3.len(), cbor.len() as i64 - zstd3.len() as i64);
        let zd3 = compress_zstd_dict(&cbor, 3, &dict);
        let ratio_d = (zd3.len() as f64 / cbor.len() as f64) * 100.0;
        println!("    zstd(3)+dict ratio: {:.1}% ({} -> {} bytes, delta {} bytes)",
            ratio_d, cbor.len(), zd3.len(), cbor.len() as i64 - zd3.len() as i64);
        println!();
    }

    // ---------------------------------------------------------------------------
    // Speed benchmark (simple timing, not criterion)
    // ---------------------------------------------------------------------------
    println!("{}", "=".repeat(80));
    println!("  Encode/Decode Speed (1000 iterations, medium token)");
    println!("{}", "=".repeat(80));

    let medium = build_medium_token();
    let cbor = token_to_cbor_bytes(&medium);
    let iterations = 1000;

    // Current pipeline
    let start = std::time::Instant::now();
    for _ in 0..iterations {
        let _ = pipeline_current(&medium);
    }
    let current_enc = start.elapsed();

    let compact_str = pipeline_current(&medium);
    let start = std::time::Instant::now();
    for _ in 0..iterations {
        let _ = Token::from_compact(&compact_str).unwrap();
    }
    let current_dec = start.elapsed();

    // zstd(3) pipeline
    let start = std::time::Instant::now();
    for _ in 0..iterations {
        let _ = pipeline_zstd(&cbor, 3);
    }
    let zstd_enc = start.elapsed();

    let zstd_compressed = compress_zstd(&cbor, 3);
    let start = std::time::Instant::now();
    for _ in 0..iterations {
        let dec = decompress_zstd(&zstd_compressed);
        let _ = ciborium::from_reader::<ciborium::Value, _>(&dec[..]).unwrap();
    }
    let zstd_dec = start.elapsed();

    // zstd(3)+dict pipeline
    let start = std::time::Instant::now();
    for _ in 0..iterations {
        let _ = pipeline_zstd_dict(&cbor, 3, &dict);
    }
    let zstd_dict_enc = start.elapsed();

    let zstd_dict_compressed = compress_zstd_dict(&cbor, 3, &dict);
    let start = std::time::Instant::now();
    for _ in 0..iterations {
        let dec = decompress_zstd_dict(&zstd_dict_compressed, &dict);
        let _ = ciborium::from_reader::<ciborium::Value, _>(&dec[..]).unwrap();
    }
    let zstd_dict_dec = start.elapsed();

    // brotli(6) pipeline
    let start = std::time::Instant::now();
    for _ in 0..iterations {
        let _ = pipeline_brotli(&cbor, 6);
    }
    let brotli_enc = start.elapsed();

    let brotli_compressed = compress_brotli(&cbor, 6);
    let start = std::time::Instant::now();
    for _ in 0..iterations {
        let dec = decompress_brotli(&brotli_compressed);
        let _ = ciborium::from_reader::<ciborium::Value, _>(&dec[..]).unwrap();
    }
    let brotli_dec = start.elapsed();

    // zlib(6) pipeline
    let start = std::time::Instant::now();
    for _ in 0..iterations {
        let _ = pipeline_zlib(&cbor);
    }
    let zlib_enc = start.elapsed();

    let zlib_compressed = compress_zlib(&cbor, 6);
    let start = std::time::Instant::now();
    for _ in 0..iterations {
        let dec = decompress_zlib(&zlib_compressed);
        let _ = ciborium::from_reader::<ciborium::Value, _>(&dec[..]).unwrap();
    }
    let zlib_dec = start.elapsed();

    println!("{:<35} {:>12} {:>12}", "Pipeline", "Encode/1K", "Decode/1K");
    println!("{:<35} {:>12.1?} {:>12.1?}", "CBOR + Base45 (current)", current_enc, current_dec);
    println!("{:<35} {:>12.1?} {:>12.1?}", "CBOR + zlib(6) + Base45", zlib_enc, zlib_dec);
    println!("{:<35} {:>12.1?} {:>12.1?}", "CBOR + zstd(3) + Base45", zstd_enc, zstd_dec);
    println!("{:<35} {:>12.1?} {:>12.1?}", "CBOR + zstd(3)+dict + Base45", zstd_dict_enc, zstd_dict_dec);
    println!("{:<35} {:>12.1?} {:>12.1?}", "CBOR + brotli(6) + Base45", brotli_enc, brotli_dec);
    println!();
}

fn print_row(label: &str, encoded_chars: usize, binary_bytes: usize, baseline_chars: usize) {
    let savings = baseline_chars as i64 - encoded_chars as i64;
    let fits = if encoded_chars <= QR_V40_L_ALNUM { "YES" } else { "NO" };
    println!("{:<42} {:>8} {:>8} {:>+9} {:>6}",
        label, encoded_chars, binary_bytes, savings, fits);
}

fn print_row_binary(label: &str, binary_bytes: usize) {
    let fits = if binary_bytes <= QR_V40_L_BYTE { "YES" } else { "NO" };
    println!("{:<42} {:>8} {:>8} {:>9} {:>6}",
        label, "n/a", binary_bytes, "", fits);
}
