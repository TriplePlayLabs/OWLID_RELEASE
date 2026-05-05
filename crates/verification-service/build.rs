//! Build script that copies Midnight Compact ZK artifacts (keys + zkir) into
//! the binary's output directory so they can be served at runtime.
//!
//! The compiled Compact contracts live at `packages/midnight-sidecar/managed/`.
//! This script copies only the heavy ZK artifacts (keys/*.prover, keys/*.verifier,
//! zkir/*.bzkir) — NOT the contract JS/types (those stay in the npm package).
//!
//! If the managed/ directory doesn't exist (contracts not compiled), the build
//! succeeds but the ZK serving endpoint will have nothing to serve.

use std::fs;
use std::path::{Path, PathBuf};

const CONTRACTS: &[&str] = &[
    "issuer_registry",
    "revocation_registry",
    "identity_registry",
];

const ZK_SUBDIRS: &[&str] = &["keys", "zkir"];

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());

    // packages/midnight-sidecar/managed/ is 2 levels up from crates/verification-service/
    let managed_dir = manifest_dir
        .join("..")
        .join("..")
        .join("packages")
        .join("midnight-sidecar")
        .join("managed");

    let zk_out = out_dir.join("zk-artifacts");

    if !managed_dir.exists() {
        println!(
            "cargo:warning=Compact managed/ dir not found at {}. ZK artifacts will not be available.",
            managed_dir.display()
        );
        // Still set the env var so env!() doesn't fail — just point to empty dir
        fs::create_dir_all(&zk_out).ok();
        println!("cargo:rustc-env=ZK_ARTIFACTS_DIR={}", zk_out.display());
        return;
    }

    for contract in CONTRACTS {
        for subdir in ZK_SUBDIRS {
            let src = managed_dir.join(contract).join(subdir);
            let dst = zk_out.join(contract).join(subdir);

            if !src.exists() {
                println!(
                    "cargo:warning=ZK artifacts not found: {}. Run `compact compile` first.",
                    src.display()
                );
                continue;
            }

            fs::create_dir_all(&dst).expect("failed to create ZK artifact output dir");
            copy_dir_files(&src, &dst);
        }
    }

    // Re-run if any ZK artifact changes
    println!("cargo:rerun-if-changed={}", managed_dir.display());
    for contract in CONTRACTS {
        for subdir in ZK_SUBDIRS {
            let src = managed_dir.join(contract).join(subdir);
            println!("cargo:rerun-if-changed={}", src.display());
        }
    }

    // Emit the path so the binary can find it
    println!("cargo:rustc-env=ZK_ARTIFACTS_DIR={}", zk_out.display());
}

fn copy_dir_files(src: &Path, dst: &Path) {
    let entries = match fs::read_dir(src) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let dest_file = dst.join(entry.file_name());
            fs::copy(&path, &dest_file).unwrap_or_else(|e| {
                panic!(
                    "failed to copy {} -> {}: {}",
                    path.display(),
                    dest_file.display(),
                    e
                )
            });
        }
    }
}
