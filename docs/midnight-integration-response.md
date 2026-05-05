Hi Hector, thanks for the thorough review — great questions. Let me address each point:

_1. Merkle Tree Operations_

Mostly correct. The primary selective-disclosure Merkle proof generation and verification runs off-chain in our Rust `proof-system` crate. However, we do use Midnight's native `MerkleTree<20, Bytes<32>>` in our Identity Registry contract for on-chain anchoring of DID commitment hashes. We're not using `merkleTreePathRoot` for credential field verification, but we are leveraging Midnight's Merkle tree primitives for identity commitment membership proofs.

_2. On-Chain Role_

Correct characterization, though we have three distinct Compact contracts rather than one:

- _Issuer Registry_ — trusted issuer whitelist, public key storage, status management
- _Revocation Registry_ — credential revocation/suspension tracking with reasons
- _Identity Registry_ — DID-to-Merkle-root commitment anchoring, on-chain Merkle tree, and DID ownership proofs via witnesses

Our verification service integrates with these through an HTTP sidecar bridge as an optional secondary check. If the chain reports a credential as revoked, we sync that back to our local DB. If the sidecar is unavailable, verification degrades gracefully to DB-only. Cryptographic verification (signatures, Merkle proof reconstruction) does run off-chain in Rust — that's by design.

_3. Signature Scheme_

Our tokens use a multi-signature model — each token carries both an _owner signature_ and an _issuer signature_. The issuer signs the credential's Merkle root with Ed25519 (with dual ECDSA P-256 support). The owner then signs the token payload using WebAuthn/passkeys, which lets users bind their credential to a hardware-backed key via biometrics rather than managing raw key material. Both signatures are verified during token verification, ensuring the credential was legitimately issued _and_ that the presenter is the rightful owner. We also support multisig (multiple owner signatures with a configurable threshold) and ring signatures for privacy-preserving group membership proofs.

On the Jubjub compatibility question — our contracts don't perform on-chain signature verification. They store raw public keys and handle lookups/status checks only. All signature verification (Ed25519, WebAuthn P-256, ring signatures) happens in the Rust verification service, so the Ed25519-vs-Jubjub gap is a non-issue in our architecture. If we ever needed on-chain signature verification, we'd either use ZK circuits to prove Ed25519 verification externally or migrate to Schnorr signatures on Jubjub for native Compact support — but that's not currently planned.

_4. Private State_

Selective disclosure is indeed off-chain via Merkle proofs — correct. However, we do use Compact's witness model for _DID ownership proofs_. Our Identity Registry declares a `witness ownerSecretKey(): Bytes<32>` — when a user registers or updates their identity, the secret key is provided as a private witness input and only its hash is stored on-chain. So we use Compact's privacy features for identity ownership, just not for selective disclosure of credential fields.

_5. Custom ZK Circuits_

Beyond the Merkle-based selective disclosure, we have three custom Groth16 circuits (BLS12-381) in our Rust `zk-circuits` crate for privacy-preserving predicate proofs:

- _Age Range_ — proves age >= threshold without revealing the actual date of birth (e.g. "over 18" without disclosing exact age)
- _Nationality_ — proves nationality is in an allowed set using MiMC Merkle tree membership, without revealing the specific country (e.g. "EU citizen" without disclosing which member state)
- _KYC Status_ — proves KYC verification level >= required threshold without revealing the actual level or details

These are generated client-side during token creation and verified by the verification service. Each proof is bound to the credential's leaf hash to prevent proof transplant attacks.

_On deeper integration:_ The current three-contract registry model is our intended architecture. Our design philosophy is blockchain for public registries and commitment anchoring, Rust for cryptographic verification and privacy-preserving proofs. Happy to jump on a call if you'd like to dig into any of this further.
