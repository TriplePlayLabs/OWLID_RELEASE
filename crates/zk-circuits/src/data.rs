//! Named, versioned datasets used as canonical inputs for set-membership circuits.
//!
//! A `Dataset` is an immutable, ordered list of string items identified by a
//! stable `name` (e.g. `"eu"`) and a `version`. Bumping `version` is the
//! migration story: a new version is a new dataset (different leaves, different
//! Merkle root) that consumers must opt into. Old versions stay around so
//! previously-issued credentials still verify against the same root.
//!
//! Datasets MAY have a normalizer that maps user-supplied input (any of
//! several conventional formats — alpha-2, alpha-3, English country name,
//! demonym, …) to the single canonical leaf string the Merkle tree contains.
//! Callers pass their input verbatim; the prover normalizes before lookup so
//! `prove(..., "Dutch", "eu")`, `prove(..., "NLD", "eu")`, and
//! `prove(..., "NL", "eu")` all generate the same proof.
//!
//! `canonical_root(name)` returns the Pedersen-MiMC Merkle root of the dataset
//! using the same leaf hash and depth as `nationality::build_nationality_tree`.
//! It is cached after first computation. The verifier uses `canonical_root`
//! to pin set-membership proofs server-side — the holder cannot ship an
//! arbitrary list and have the verifier rubber-stamp it.

use ark_bls12_381::Fr;
use ark_serialize::CanonicalSerialize;
use std::collections::HashMap;
use std::sync::LazyLock;

use crate::nationality::build_nationality_tree;

/// An immutable, named, versioned set of string items.
///
/// `items` are the leaves of the Merkle tree (canonical form). `normalize`,
/// when set, maps user input to a leaf string before lookup.
#[derive(Clone, Copy)]
pub struct Dataset {
    pub name: &'static str,
    pub version: u32,
    pub items: &'static [&'static str],
    pub normalize: Option<fn(&str) -> Option<&'static str>>,
}

impl std::fmt::Debug for Dataset {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Dataset")
            .field("name", &self.name)
            .field("version", &self.version)
            .field("items.len", &self.items.len())
            .finish()
    }
}

impl Dataset {
    /// Map an input string to its canonical leaf string for this dataset, or
    /// `None` if the input does not belong to the set.
    pub fn canonicalize<'a>(&'a self, input: &str) -> Option<&'a str> {
        if let Some(norm) = self.normalize {
            return norm(input);
        }
        self.items.iter().copied().find(|c| *c == input)
    }
}

/// Member states of the European Union (27 members as of 2026), addressed
/// by any of: ISO 3166-1 alpha-2, alpha-3, English country name, or
/// English demonym (case-insensitive). Leaves are alpha-2 codes; the
/// normalizer maps the other forms to alpha-2 before lookup.
pub const EU: Dataset = Dataset {
    name: "eu",
    version: 1,
    items: EU_ALPHA2_LEAVES,
    normalize: Some(normalize_eu),
};

const EU_ALPHA2_LEAVES: &[&str] = &[
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT",
    "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
];

/// Map any common encoding of an EU member state to its alpha-2 leaf string.
/// Returns `None` for non-EU input. Case-insensitive.
fn normalize_eu(input: &str) -> Option<&'static str> {
    let trimmed = input.trim();
    let upper = trimmed.to_ascii_uppercase();
    let lower = trimmed.to_ascii_lowercase();

    // Pass-through: already alpha-2 in the set.
    if let Some(code) = EU_ALPHA2_LEAVES.iter().copied().find(|c| *c == upper) {
        return Some(code);
    }

    // Alpha-3 → alpha-2.
    let alpha3 = match upper.as_str() {
        "AUT" => "AT", "BEL" => "BE", "BGR" => "BG", "HRV" => "HR",
        "CYP" => "CY", "CZE" => "CZ", "DNK" => "DK", "EST" => "EE",
        "FIN" => "FI", "FRA" => "FR", "DEU" => "DE", "GRC" => "GR",
        "HUN" => "HU", "IRL" => "IE", "ITA" => "IT", "LVA" => "LV",
        "LTU" => "LT", "LUX" => "LU", "MLT" => "MT", "NLD" => "NL",
        "POL" => "PL", "PRT" => "PT", "ROU" => "RO", "SVK" => "SK",
        "SVN" => "SI", "ESP" => "ES", "SWE" => "SE",
        _ => "",
    };
    if !alpha3.is_empty() {
        return Some(alpha3);
    }

    // English country names and demonyms (lower-cased).
    let by_name = match lower.as_str() {
        "austria"        | "austrian"          => "AT",
        "belgium"        | "belgian"           => "BE",
        "bulgaria"       | "bulgarian"         => "BG",
        "croatia"        | "croatian"          => "HR",
        "cyprus"         | "cypriot"           => "CY",
        "czechia"        | "czech republic"
                         | "czech"             => "CZ",
        "denmark"        | "danish"            => "DK",
        "estonia"        | "estonian"          => "EE",
        "finland"        | "finnish"           => "FI",
        "france"         | "french"            => "FR",
        "germany"        | "german"            => "DE",
        "greece"         | "greek"             => "GR",
        "hungary"        | "hungarian"         => "HU",
        "ireland"        | "irish"             => "IE",
        "italy"          | "italian"           => "IT",
        "latvia"         | "latvian"           => "LV",
        "lithuania"      | "lithuanian"        => "LT",
        "luxembourg"     | "luxembourgish"     => "LU",
        "malta"          | "maltese"           => "MT",
        "netherlands"    | "the netherlands"
                         | "dutch"             => "NL",
        "poland"         | "polish"            => "PL",
        "portugal"       | "portuguese"        => "PT",
        "romania"        | "romanian"          => "RO",
        "slovakia"       | "slovak"            => "SK",
        "slovenia"       | "slovenian"         => "SI",
        "spain"          | "spanish"           => "ES",
        "sweden"         | "swedish"           => "SE",
        _ => "",
    };
    if !by_name.is_empty() {
        return Some(by_name);
    }

    None
}

const ALL_DATASETS: &[&Dataset] = &[&EU];

/// Look up a dataset by its `name`. Returns `None` if no dataset is registered.
pub fn lookup(name: &str) -> Option<&'static Dataset> {
    ALL_DATASETS.iter().copied().find(|d| d.name == name)
}

/// All registered datasets. Order is stable but not semantically meaningful.
pub fn list_datasets() -> &'static [&'static Dataset] {
    ALL_DATASETS
}

static CANONICAL_ROOTS: LazyLock<HashMap<&'static str, Fr>> = LazyLock::new(|| {
    let mut map = HashMap::with_capacity(ALL_DATASETS.len());
    for ds in ALL_DATASETS {
        let (root, _) = build_nationality_tree(ds.items);
        map.insert(ds.name, root);
    }
    map
});

/// Canonical Merkle root for the dataset's set-membership tree. Cached.
///
/// Uses the same leaf hash + depth as `nationality::build_nationality_tree`,
/// so a proof generated with `nationality::prove(.., dataset.items)` verifies
/// against this root.
pub fn canonical_root(name: &str) -> Option<Fr> {
    CANONICAL_ROOTS.get(name).copied()
}

fn fr_to_hex(fr: &Fr) -> String {
    let mut bytes = Vec::new();
    fr.serialize_compressed(&mut bytes)
        .expect("Fr compressed serialization is infallible");
    hex::encode(bytes)
}

/// Hex-encoded serialization of `Fr::from(value)` matching the public-input
/// format of the age-range / KYC circuits.
pub fn canonical_threshold_input_hex(value: u64) -> String {
    fr_to_hex(&Fr::from(value))
}

/// Hex-encoded serialization of the canonical Merkle root for the named
/// set-membership dataset, matching the public-input format the nationality
/// circuit emits. Returns `None` if the name is not registered.
pub fn canonical_set_root_hex(name: &str) -> Option<String> {
    canonical_root(name).as_ref().map(fr_to_hex)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eu_has_27_leaves() {
        assert_eq!(EU.items.len(), 27);
    }

    #[test]
    fn lookup_returns_registered_datasets() {
        assert!(lookup("eu").is_some());
        assert!(lookup("nope").is_none());
    }

    #[test]
    fn canonical_root_is_cached_and_matches_tree() {
        let direct = build_nationality_tree(EU.items).0;
        let cached = canonical_root("eu").expect("eu root");
        assert_eq!(direct, cached);
        assert_eq!(canonical_root("eu"), Some(direct));
    }

    #[test]
    fn canonical_root_unknown_returns_none() {
        assert!(canonical_root("eu-alpha9999").is_none());
    }

    #[test]
    fn canonicalize_handles_alpha2_alpha3_names_and_demonyms() {
        assert_eq!(EU.canonicalize("NL"), Some("NL"));
        assert_eq!(EU.canonicalize("nl"), Some("NL"));
        assert_eq!(EU.canonicalize("NLD"), Some("NL"));
        assert_eq!(EU.canonicalize("Dutch"), Some("NL"));
        assert_eq!(EU.canonicalize("Netherlands"), Some("NL"));
        assert_eq!(EU.canonicalize("the netherlands"), Some("NL"));
        assert_eq!(EU.canonicalize("German"), Some("DE"));
        assert_eq!(EU.canonicalize("Sweden"), Some("SE"));
        assert_eq!(EU.canonicalize("FRA"), Some("FR"));
    }

    #[test]
    fn canonicalize_rejects_non_eu() {
        assert!(EU.canonicalize("US").is_none());
        assert!(EU.canonicalize("USA").is_none());
        assert!(EU.canonicalize("American").is_none());
    }
}
