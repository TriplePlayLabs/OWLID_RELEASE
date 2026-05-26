//! Embedded predicate Compact artifacts (one set per per-predicate
//! contract).
//!
//! The holder app's WASM build skips the multi-MB proving keys and
//! fetches them lazily from this trusted origin. zkir + prover +
//! verifier per attest circuit, baked into the binary so there is no
//! filesystem/deploy-path coupling. The compactc-generated contract
//! modules (small ABI JS) are vendored into `@owlid/sdk` separately —
//! only the heavy artifacts are served here.
//!
//! Filenames are `<circuit>.<kind>`, `kind ∈ {bzkir, prover,
//! verifier}`, matching the `ZkConfigProvider` filesystem layout the
//! holder rebuilds from these bytes.

macro_rules! asset {
    ($f:literal) => {
        include_bytes!(concat!("../predicate-assets/", $f))
    };
}

// ----- attestAgeGte (predicate_age) ----------------------------------
const AGE_BZKIR: &[u8] = asset!("attestAgeGte.bzkir");
const AGE_PROVER: &[u8] = asset!("attestAgeGte.prover");
const AGE_VERIFIER: &[u8] = asset!("attestAgeGte.verifier");

// ----- attestKycGte (predicate_kyc) ----------------------------------
const KYC_BZKIR: &[u8] = asset!("attestKycGte.bzkir");
const KYC_PROVER: &[u8] = asset!("attestKycGte.prover");
const KYC_VERIFIER: &[u8] = asset!("attestKycGte.verifier");

// ----- attestNationalityIn (predicate_nationality) -------------------
const NAT_BZKIR: &[u8] = asset!("attestNationalityIn.bzkir");
const NAT_PROVER: &[u8] = asset!("attestNationalityIn.prover");
const NAT_VERIFIER: &[u8] = asset!("attestNationalityIn.verifier");

// ----- attestResidency (predicate_residency) -------------------------
const RES_BZKIR: &[u8] = asset!("attestResidency.bzkir");
const RES_PROVER: &[u8] = asset!("attestResidency.prover");
const RES_VERIFIER: &[u8] = asset!("attestResidency.verifier");

// ----- attestEmailVerified (predicate_email) -------------------------
const EMAIL_BZKIR: &[u8] = asset!("attestEmailVerified.bzkir");
const EMAIL_PROVER: &[u8] = asset!("attestEmailVerified.prover");
const EMAIL_VERIFIER: &[u8] = asset!("attestEmailVerified.verifier");

// ----- attestAgeRange (predicate_age_range) --------------------------
const AGE_RANGE_BZKIR: &[u8] = asset!("attestAgeRange.bzkir");
const AGE_RANGE_PROVER: &[u8] = asset!("attestAgeRange.prover");
const AGE_RANGE_VERIFIER: &[u8] = asset!("attestAgeRange.verifier");

// ----- attestUniquePersonhood (predicate_personhood) -----------------
const PERSONHOOD_BZKIR: &[u8] = asset!("attestUniquePersonhood.bzkir");
const PERSONHOOD_PROVER: &[u8] = asset!("attestUniquePersonhood.prover");
const PERSONHOOD_VERIFIER: &[u8] = asset!("attestUniquePersonhood.verifier");

/// Resolve `<circuit>.<kind>` to its bytes. Names match the on-disk
/// compactc artifact filenames so the holder's `ZkConfigProvider` sees
/// an identical layout.
pub fn lookup(filename: &str) -> Option<&'static [u8]> {
    Some(match filename {
        "attestAgeGte.bzkir" => AGE_BZKIR,
        "attestAgeGte.prover" => AGE_PROVER,
        "attestAgeGte.verifier" => AGE_VERIFIER,
        "attestKycGte.bzkir" => KYC_BZKIR,
        "attestKycGte.prover" => KYC_PROVER,
        "attestKycGte.verifier" => KYC_VERIFIER,
        "attestNationalityIn.bzkir" => NAT_BZKIR,
        "attestNationalityIn.prover" => NAT_PROVER,
        "attestNationalityIn.verifier" => NAT_VERIFIER,
        "attestResidency.bzkir" => RES_BZKIR,
        "attestResidency.prover" => RES_PROVER,
        "attestResidency.verifier" => RES_VERIFIER,
        "attestEmailVerified.bzkir" => EMAIL_BZKIR,
        "attestEmailVerified.prover" => EMAIL_PROVER,
        "attestEmailVerified.verifier" => EMAIL_VERIFIER,
        "attestAgeRange.bzkir" => AGE_RANGE_BZKIR,
        "attestAgeRange.prover" => AGE_RANGE_PROVER,
        "attestAgeRange.verifier" => AGE_RANGE_VERIFIER,
        "attestUniquePersonhood.bzkir" => PERSONHOOD_BZKIR,
        "attestUniquePersonhood.prover" => PERSONHOOD_PROVER,
        "attestUniquePersonhood.verifier" => PERSONHOOD_VERIFIER,
        _ => return None,
    })
}

/// Every served filename — drives the holder's prefetch list so SDK and
/// verifier never disagree on the artifact set.
pub const ALL: &[&str] = &[
    "attestAgeGte.bzkir",
    "attestAgeGte.prover",
    "attestAgeGte.verifier",
    "attestKycGte.bzkir",
    "attestKycGte.prover",
    "attestKycGte.verifier",
    "attestNationalityIn.bzkir",
    "attestNationalityIn.prover",
    "attestNationalityIn.verifier",
    "attestResidency.bzkir",
    "attestResidency.prover",
    "attestResidency.verifier",
    "attestEmailVerified.bzkir",
    "attestEmailVerified.prover",
    "attestEmailVerified.verifier",
    "attestAgeRange.bzkir",
    "attestAgeRange.prover",
    "attestAgeRange.verifier",
    "attestUniquePersonhood.bzkir",
    "attestUniquePersonhood.prover",
    "attestUniquePersonhood.verifier",
];
