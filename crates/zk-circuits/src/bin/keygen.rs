//! Groth16 key generation for OwlID circuits.
//!
//! Runs `setup()` for each circuit, writes the proving key (`<circuit>.pk.bin`)
//! and prepared verifying key (`<circuit>.vk.bin`) into `artifacts/` next to
//! this crate. Output bytes are `ark-serialize` compressed and intended to be
//! consumed by `lib.rs`'s `include_bytes!` macros.
//!
//! ## Bootstrap
//!
//! `lib.rs` `include_bytes!`s the artifacts under the `verifier` /
//! `prover-keys-embedded` features. On a fresh checkout where the artifacts
//! do not yet exist, build this binary with no default features so the
//! lib still compiles:
//!
//! ```sh
//! cargo run -p owl-zk-circuits --bin keygen --no-default-features
//! ```
//!
//! Once the files are written, the rest of the workspace builds normally.
//! The `just generate-zk-keys` recipe wraps this.
//!
//! ## SECURITY — read this before promoting to production
//!
//! The seeds used here are **fixed constants**. The toxic waste from a
//! `circuit_specific_setup` with a known seed is recoverable by anyone who
//! reads this source file, and a holder of the toxic waste can forge proofs
//! that verify against the committed verifying key. **This is acceptable for
//! development and CI only.**
//!
//! For production deployment, replace this binary's seed-based setup with a
//! real Phase-2 multi-party ceremony (see `crates/zk-circuits/CEREMONY.md`).
//! The artifact format and consumer code do not change — only the bytes do.

use ark_serialize::CanonicalSerialize;
use owl_zk_circuits::{age_range, kyc_status, nationality};
use std::fs;
use std::path::PathBuf;

fn artifacts_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("artifacts")
}

fn write_artifact(name: &str, bytes: &[u8]) -> std::io::Result<()> {
    let path = artifacts_dir().join(name);
    fs::write(&path, bytes)?;
    println!("  wrote {} ({} bytes)", path.display(), bytes.len());
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(artifacts_dir())?;
    println!("Generating Groth16 keys (DEV SEEDS — see file header):");

    // age_range
    {
        println!("- age_range");
        let (pk, pvk) = age_range::setup()?;
        let mut pk_bytes = Vec::new();
        pk.serialize_compressed(&mut pk_bytes)?;
        let mut vk_bytes = Vec::new();
        pvk.serialize_compressed(&mut vk_bytes)?;
        write_artifact("age_range.pk.bin", &pk_bytes)?;
        write_artifact("age_range.vk.bin", &vk_bytes)?;
    }

    // kyc_status
    {
        println!("- kyc_status");
        let (pk, pvk) = kyc_status::setup()?;
        let mut pk_bytes = Vec::new();
        pk.serialize_compressed(&mut pk_bytes)?;
        let mut vk_bytes = Vec::new();
        pvk.serialize_compressed(&mut vk_bytes)?;
        write_artifact("kyc_status.pk.bin", &pk_bytes)?;
        write_artifact("kyc_status.vk.bin", &vk_bytes)?;
    }

    // nationality
    {
        println!("- nationality");
        let (pk, pvk) = nationality::setup()?;
        let mut pk_bytes = Vec::new();
        pk.serialize_compressed(&mut pk_bytes)?;
        let mut vk_bytes = Vec::new();
        pvk.serialize_compressed(&mut vk_bytes)?;
        write_artifact("nationality.pk.bin", &pk_bytes)?;
        write_artifact("nationality.vk.bin", &vk_bytes)?;
    }

    println!("Done.");
    Ok(())
}
