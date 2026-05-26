# OwlID Compact Contracts

Per-contract reference for the OwlID on-chain layer. For the Compact _language_
see `COMPACT.md`; for how the contracts fit the system see `MIDNIGHT.md` and
`ARCHITECTURE.md`.

Source: `packages/midnight-sidecar/contracts/`. Ten contracts —
three registries plus seven predicate contracts — all
`pragma language_version >= 0.23`, all importing the vendored OpenZeppelin
Compact stdlib under `contracts/lib/` (`access/Ownable`,
`security/Pausable`, `security/Initializable`).

Every contract is `Ownable` (an `initialOwner` set in the constructor) and
`Pausable` (owner-gated `pause`/`unpause`; state-mutating circuits assert
`Pausable_assertNotPaused()`). Those common circuits — `pause`, `unpause`,
`transferOwnership`, `owner`, `isPaused` — are omitted from the per-circuit
tables below.

All on-chain identifiers are 32-byte values. The credential handle the
registries and predicates key on is `credential_id_hex` — the raw 32-byte
SHA-256 digest of the issuer JWT (the `rootHash` parameter name in the source
is a legacy term from the pre-SD-JWT-VC Merkle era; it carries the credential
id today). PII never reaches a contract; only commitments and hashes do.

---

## Registry contracts

### `issuer_registry`

Trusted credential issuers. Owner-gated writes — only the OwlID operator
registers or deactivates issuers.

**Ledger state**

| Field               | Type                               | Holds                                  |
| ------------------- | ---------------------------------- | -------------------------------------- |
| `issuerCount`       | `Counter`                          | Number of registered issuers.          |
| `issuerStatuses`    | `Map<Bytes<32>, IssuerStatus>`     | keyHash → INACTIVE/ACTIVE/DEACTIVATED. |
| `issuerKeys`        | `Map<Bytes<32>, Bytes<32>>`        | keyHash → issuer public key.           |
| `issuerNames`       | `Map<Bytes<32>, Opaque<"string">>` | keyHash → display name.                |
| `registeredIssuers` | `Set<Bytes<32>>`                   | Membership set of keyHashes.           |

`keyHash = persistentHash(publicKey)`. `enum IssuerStatus { INACTIVE, ACTIVE, DEACTIVATED }`.

**Circuits**

| Circuit                                     | Auth   | Effect                                                                                |
| ------------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| `registerIssuer(publicKey, name)`           | owner  | Insert/re-register an issuer as ACTIVE. Rejects an already-ACTIVE or DEACTIVATED key. |
| `deactivateIssuer(keyHash)`                 | owner  | ACTIVE → DEACTIVATED.                                                                 |
| `reactivateIssuer(keyHash)`                 | owner  | DEACTIVATED → ACTIVE.                                                                 |
| `isTrusted(publicKey)` → `Boolean`          | public | True iff the key's status is ACTIVE.                                                  |
| `isTrustedByHash(keyHash)` → `Boolean`      | public | Same, keyed by hash.                                                                  |
| `getIssuerStatus(keyHash)` → `IssuerStatus` | public | Status, or INACTIVE if unknown.                                                       |
| `getIssuerKey(keyHash)` → `Bytes<32>`       | public | The registered public key.                                                            |

### `revocation_registry`

Credential revocation. Owner-gated writes.

**Ledger state**

| Field                | Type                                | Holds                                            |
| -------------------- | ----------------------------------- | ------------------------------------------------ |
| `credentialStatuses` | `Map<Bytes<32>, CredentialStatus>`  | credentialId → ACTIVE/REVOKED/SUSPENDED.         |
| `credentialIssuers`  | `Map<Bytes<32>, Bytes<32>>`         | credentialId → issuer key hash.                  |
| `credentialReasons`  | `Map<Bytes<32>, Opaque<"string">>`  | credentialId → reason string.                    |
| `revokedCredentials` | `Set<Bytes<32>>`                    | Current revocations — fast verifier membership.  |
| `revokedTree`        | `HistoricMerkleTree<32, Bytes<32>>` | Append-only audit log of every revocation event. |
| `revocationCount`    | `Counter`                           | Lifetime revocation events.                      |

`enum CredentialStatus { ACTIVE, REVOKED, SUSPENDED }`. Witness
`revocationPath(rootHash)` supplies a Merkle path for inclusion proofs.

**Circuits**

| Circuit                                    | Auth   | Effect                                                                                    |
| ------------------------------------------ | ------ | ----------------------------------------------------------------------------------------- |
| `revoke(rootHash, issuerKeyHash, reason)`  | owner  | → REVOKED. Adds to `revokedCredentials` + `revokedTree`.                                  |
| `suspend(rootHash, issuerKeyHash, reason)` | owner  | → SUSPENDED. Adds to both. Cannot suspend a REVOKED credential.                           |
| `reactivate(rootHash, issuerKeyHash)`      | owner  | SUSPENDED → ACTIVE. Removes from `revokedCredentials`; `revokedTree` stays (append-only). |
| `isRevoked(rootHash)` → `Boolean`          | public | True if REVOKED or SUSPENDED.                                                             |
| `getStatus(rootHash)` → `CredentialStatus` | public | Status, or ACTIVE if unknown.                                                             |
| `getIssuer(rootHash)` → `Bytes<32>`        | public | The recorded issuer key hash.                                                             |
| `proveRevocationInclusion(rootHash)`       | public | Verifies a witnessed Merkle path against a historic `revokedTree` root.                   |

REVOKED is terminal; SUSPENDED is reversible via `reactivate`.

### `identity_registry`

Anchors credential / DID-document commitments — the did:webs doc-hash anchor.
Privacy-preserving: only commitments, never raw PII.

**Ledger state**

| Field                   | Type                               | Holds                                       |
| ----------------------- | ---------------------------------- | ------------------------------------------- |
| `commitments`           | `Map<Bytes<32>, Bytes<32>>`        | didHash → commitment (`sha-256(did.json)`). |
| `commitmentStatuses`    | `Map<Bytes<32>, CommitmentStatus>` | didHash → INACTIVE/ACTIVE/EXPIRED.          |
| `commitmentIssuers`     | `Map<Bytes<32>, Bytes<32>>`        | didHash → issuer key hash.                  |
| `didOwners`             | `Map<Bytes<32>, Bytes<32>>`        | didHash → owner hash (witness-derived).     |
| `registeredCommitments` | `Set<Bytes<32>>`                   | Membership set of commitments.              |
| `identityCount`         | `Counter`                          | Registered identities.                      |

`enum CommitmentStatus { INACTIVE, ACTIVE, EXPIRED }`. Witness
`ownerSecretKey()` derives `ownerHash = persistentHash(["owlid:did:owner:", sk])`,
proving DID ownership without revealing the secret.

**Circuits**

| Circuit                                                         | Auth          | Effect                                                                               |
| --------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| `registerIdentity(didHash, commitment, issuerKeyHash)`          | witness-gated | Anchor a new ACTIVE commitment. Rejects a DID that already has an ACTIVE commitment. |
| `updateCommitment(didHash, newCommitment, issuerKeyHash)`       | DID owner     | Replace the commitment — requires the `ownerSecretKey` witness to match `didOwners`. |
| `adminUpdateCommitment(didHash, newCommitment, issuerKeyHash)`  | owner         | Operator override.                                                                   |
| `expireCommitment(didHash)`                                     | owner         | ACTIVE → EXPIRED.                                                                    |
| `isCommitmentRegistered(commitment)` → `Boolean`                | public        | Membership check.                                                                    |
| `getCommitment` / `getCommitmentStatus` / `getCommitmentIssuer` | public        | Lookups by `didHash`.                                                                |

---

## Predicate contracts

Seven contracts, one per predicate kind — split apart because Midnight's
per-extrinsic block-weight cap will not carry them in one contract. They share
a structure:

**Common ledger state**

| Field          | Type                                | Holds                                        |
| -------------- | ----------------------------------- | -------------------------------------------- |
| `attestations` | `Set<Bytes<32>>`                    | Attestation keys — what the verifier checks. |
| `attestTree`   | `HistoricMerkleTree<32, Bytes<32>>` | Append-only audit trail of attestations.     |
| `attestCount`  | `Counter`                           | Lifetime attestations.                       |

**Common circuits**

- `attest*(...)` — the kind-specific circuit (table below). Asserts the
  private witness satisfies the predicate, then `record(keyOf(tag, credentialId, param))`
  inserts the attestation key.
- `isAttested(key)` → `Boolean` — public membership check.

**Attestation key recipe** — identical across kinds, parity-tested against
`crates/proof-system/src/attestation.rs`:

```
key = persistentHash<Vector<3,Bytes<32>>>([ pad32(tag), credentialId, param ])
```

The witness is consumed inside the circuit on the holder's device; only the
ZK proof and the public key reach the chain. The verifier **recomputes** the
key from the issuer-signed credential id — it never trusts a key from the
presentation.

| Contract                | Circuit                                          | Witness                                        | `tag`                  | `param`                            |
| ----------------------- | ------------------------------------------------ | ---------------------------------------------- | ---------------------- | ---------------------------------- |
| `predicate_age`         | `attestAgeGte(rootHash, threshold)`              | `ageValue: Uint<16>`                           | `owlid:attest:age:`    | `threshold` as `Bytes<32>`         |
| `predicate_age_range`   | `attestAgeRange(rootHash, minAge, maxAge)`       | `ageValue: Uint<16>`                           | `owlid:attest:agerng:` | `persistentHash([minAge, maxAge])` |
| `predicate_kyc`         | `attestKycGte(rootHash, threshold)`              | `kycLevel: Uint<8>`                            | `owlid:attest:kyc:`    | `threshold` as `Bytes<32>`         |
| `predicate_residency`   | `attestResidency(rootHash)`                      | `residencyValue: Uint<8>`                      | `owlid:attest:res:`    | `pad32("")`                        |
| `predicate_email`       | `attestEmailVerified(rootHash)`                  | `emailVerifiedFlag: Uint<8>`                   | `owlid:attest:email:`  | `pad32("")`                        |
| `predicate_nationality` | `attestNationalityIn(rootHash)`                  | `nationalityPath: MerkleTreePath<5,Bytes<32>>` | `owlid:attest:nat:`    | `pad32("")`                        |
| `predicate_personhood`  | `attestUniquePersonhood(rootHash, epoch, appId)` | `personhoodSecret: Bytes<32>`                  | `owlid:attest:uniq:`   | `persistentHash([epoch, appId])`   |

### Kind notes

- **`predicate_age` / `predicate_kyc`** — assert `value >= threshold`. The
  threshold is public (it is in the verifier's DCQL request); the value is the
  witness.
- **`predicate_age_range`** — asserts `minAge <= age <= maxAge`.
- **`predicate_residency` / `predicate_email`** — boolean: assert the witness
  flag `>= 1`. `param` is empty since there is nothing to parameterize.
- **`predicate_nationality`** — set membership. The contract holds an
  owner-seeded `approvedNationality: HistoricMerkleTree<5,Bytes<32>>`
  (leaves are `persistentHash(countryCode)`, ≤32 entries). `seedNationality(leaf)`
  is owner-gated. The holder witnesses a `MerkleTreePath` proving their country
  is in the tree; the code itself never appears as a circuit argument.
- **`predicate_personhood`** — sybil-resistant unique personhood. In addition
  to `attestations` it maintains `nullifiers: Set<Bytes<32>>`. The circuit
  computes `nullifier = persistentHash([secret, epoch, appId])`, asserts it is
  not already present, and inserts it. One human (one `personhoodSecret`)
  cannot attest twice within the same `(epoch, appId)` scope; across different
  campaigns the nullifiers differ, so claims stay uncorrelated. The
  `personhoodSecret` is issuer-derived per real human, stored only in the
  wallet's local `verifiedClaims`, and is never an SD-JWT disclosure.

---

## `lib/` — vendored OpenZeppelin Compact stdlib

`contracts/lib/` carries the vendored OpenZeppelin Compact modules every
contract imports: `access/Ownable`, `security/Pausable`,
`security/Initializable`, and `utils/`. They are upstream code — do not edit
in place; re-vendor on upgrade.

---

## Deployment & addresses

Contracts are compiled with the Compact compiler (`just compact` /
`compact-fast`) and deployed to Midnight by the sidecar (`just deploy-contracts`).
Each deployed contract has its own address; the sidecar holds the address set
in its environment and routes `/api/{issuers,revocations,identities,predicates}/*`
to the right contract. See `MIDNIGHT.md` for the full deployment and
state-sync picture.
