// Doc comments use `+` as a prose connector ("sorted + deduped + ...") which
// clippy's markdown heuristic flags as lazy list continuations. The prose is
// intentional; the lint is cosmetic (rustdoc rendering only).
#![allow(clippy::doc_lazy_continuation)]

pub mod encryption;
pub mod hash;
pub mod ring_sig;
pub mod signature;
pub mod webauthn;

pub use encryption::{EncryptionError, decrypt, encrypt, key_from_hex};
pub use hash::{HashAlgorithm, generate_salt, hash_attribute, hash_attribute_salted};
pub use ring_sig::{RingSignature, RingSignatureError};
pub use signature::{KeyPair, PublicKey, Signature, SignatureAlgorithm};
pub use webauthn::{CoseKey, WebAuthnError, WebAuthnSignature};
