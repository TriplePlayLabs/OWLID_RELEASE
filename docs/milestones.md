## 1. Smart Contracts (Compact)

**Deployment of validator contract, Merkle root commitment contract.**

### What must be built

1. **Validator contract (Compact)**
   Functions:

   * Register a validator with address, DID.
   * Activate or deactivate validator status based on KYB status.

   Data:

   * Mapping from validator address to: active/inactive status, validator DID, last update timestamp.

   Events:

   * `ValidatorRegistered(address, did)`
   * `ValidatorActivated(address)`
   * `ValidatorDeactivated(address)`

2. **Merkle root commitment contract (Compact)**
   Functions:

   * Store new Merkle roots for credential or token batches per issuer and schema.
   * Update an existing root with versioning or timestamp.
   * Retrieve the latest valid root per issuer DID and schema ID.

   Data:

   * Structure per `(issuerDid, schemaId)`: current root hash, previous root hash, createdAt, updatedAt, optional metadata.

   Events:

   * `RootCommitted(issuerDid, schemaId, rootHash, timestamp)`
   * `RootUpdated(issuerDid, schemaId, oldRootHash, newRootHash, timestamp)`

3. **Access control**

   * Only authorised issuers or a Registry contract can write roots.
   * Only active validators can interact with staking functions.

### Definition of done

* Compact contracts compile and pass unit tests.
* Contracts are deployed on Midnight testnet.
* A deploy or smoke test script can:

  * Register at least one validator.
  * Commit at least one Merkle root and read it back.
* Short technical documentation exists:

  * Contract interfaces, events and example transactions.

---

## 2. ZK Predicate Circuits

**Development and testing of core zero-knowledge proofs (age, nationality, KYC).**

### What must be built

1. **Age predicate circuit**

   * Inputs:

     * Private: date of birth (or hash plus salt).
     * Public: reference date or current date, minimum required age (for example 18).
   * Statement:

     * Prove that `age >= minAge` without revealing the actual date of birth.

2. **Nationality predicate circuit**

   * Inputs:

     * Private: nationality code or hash of nationality attribute.
     * Public: set identifier or policy identifier for allowed nationalities.
   * Statement:

     * Prove that the nationality belongs to a configured allowed set, for example EU countries, without revealing the exact country if policy does not require it.

3. **KYC status predicate circuit**

   * Inputs:

     * Private: KYC status or credential leaf plus Merkle path.
     * Public: issuer root commitment from the Merkle root commitment contract.
   * Statement:

     * Prove that the subject has KYC status VERIFIED inside a Merkle tree that matches the on chain root for the issuer.

4. **Circuit interface and formats**

   * Fixed structure for:

     * Public inputs (what the verifier sees).
     * Private inputs (what remains in the wallet).
     * Merkle paths and hash function used for inclusion checks.
   * Alignment with the Merkle library and the root format that is committed on chain.

### Definition of done

* At least three working circuits exist:

  * Age predicate.
  * Nationality predicate.
  * KYC status predicate.
* Each circuit has an automated test suite with:

  * Positive cases that should verify.
  * Negative cases that must fail.
* Benchmark numbers for proving time on a reference machine are available.
* Proving keys and verification keys are generated, versioned and documented for use by the SDK and the backend.
* Technical documentation describes:

  * The statement each circuit proves.
  * Input formats.
  * Known limitations and assumptions.

---

## 3. Merkle Tree and Proof System

**Implementation of hashing, Merkle tree construction, and proof of inclusion document format.**

### What must be built

1. **Hashing layer**

   * A deterministic attribute encoding:

     * Canonical JSON or similar for `key` and `value`.
     * SHA-256 for `leafHash = SHA-256(encode(key) || encode(value))`.
   * A function for combining two child hashes into a parent hash using SHA-256.

2. **Merkle tree implementation**

   * API to:

     * Build a Merkle tree from an ordered list of leaves.
     * Return the root hash.
     * Generate a proof of inclusion for a given leaf index.
   * Support for a configurable number of leaves.

3. **Proof document format**

   * A concrete Proof Document structure, for example:

     * `rootHash`: string (hex encoded SHA-256).
     * `leaves`: list of leaf identifiers or attribute paths.
     * `paths`: for each leaf, a list of sibling hashes plus a left or right flag.
   * Types for this format in TypeScript and in the low level language used for the SDK core.

4. **Verification functions**

   * Pure functions to:

     * Recompute the root from a leaf hash and its Merkle path.
     * Compare the recomputed root with the claimed `rootHash`.
   * These functions must be reusable in:

     * The SDK.
     * The Token Verification Service.

### Definition of done

* A Merkle library exists in the chosen languages with:

  * Tree construction.
  * Inclusion proof generation.
  * Inclusion proof verification.
* Unit tests cover:

  * Correct roots for known test vectors.
  * Both valid and invalid proofs.
* Documentation describes:

  * How leaves are encoded.
  * The exact proof format.
* A minimal example demonstrates:

  * Document to leaves.
  * Leaves to Merkle tree.
  * Proof Document creation.

---

## 4. Proof Generator SDK

**Creation of SDK enabling token generation with Merkle inclusion and ZK proof wrapper.**

### What must be built

1. **Public SDK API**
   Core functions, for example:

   * `createProofDocument(document, issuerKey, ownerKey)`
   * `generateToken(proofDocument, requestedAttributes, challenge, predicates)`
   * Optional `verifyTokenLocal(token)` for local pre-checks.

   Inputs must allow:

   * Selection of which attributes become visible.
   * Selection of which predicates to prove (age, nationality, KYC).

2. **Integration with Merkle and ZK**

   * Automatic:

     * Derive leaf hashes from a document.
     * Build Merkle tree, compute `rootHash`.
     * Generate Merkle paths for attributes used in the token.
   * ZK integration:

     * Call into ZK libraries to create proofs for the requested predicates.
     * Wrap proofs and Merkle paths inside the token payload.

3. **Target environments**

   * Browser environment for use in wallets.
   * Node environment for test tools and back office scripts.
   * Build pipeline that outputs bundles suitable for both.

4. **Developer ergonomics**

   * Full TypeScript typings.
   * A configuration object that allows:

     * Circuit versions.
     * Hash options if needed.
     * Logging or debug options.

### Definition of done

* SDK is packaged and can be installed as a library in a demo wallet.
* Example code exists that:

  * Takes a sample document.
  * Creates a Proof Document.
  * Generates a token with at least one ZK predicate.
* Automated tests cover:

  * Happy path flows.
  * Error cases such as missing attributes or mismatched circuits.
* A short "getting started" guide exists with code samples.

---

## 5. Token Verification Service

**Backend service for verifying proofs and KYB registry lookups. Responsive Verifier web app. Whitelisted Validator Registry (KYB). 1 Midnight DID integration (Midnames or other).**

### What must be built

1. **Verification backend service**

   * API endpoints:

     * `POST /verify` that accepts a token payload.
   * Verification steps per request:

     * Validate ZK proofs using the correct verifier keys.
     * Validate Merkle inclusion: recompute leaf root and compare with token `rootHash`.
     * Resolve `rootHash` against the Merkle root commitment contract on Midnight testnet.
     * Perform KYB check: look up issuer or validator in the Whitelisted Validator Registry.
   * Response:

     * `status`: ACCEPTED or REJECTED.
     * `reasonCode`: such as `OK`, `INVALID_PROOF`, `UNKNOWN_ROOT`, `ISSUER_NOT_WHITELISTED`.
     * Optional metadata like issuer DID and schema.

2. **Whitelisted Validator Registry (KYB) in backend**

   * Persistent store that maps validator or issuer identifiers to:

     * DID.
     * Legal entity information.
     * KYB status (active, suspended, revoked).
   * Admin or internal API to create, update and deactivate entries.
   * Integration into verification flow to reject tokens from non-whitelisted or suspended issuers or validators.

3. **Midnight DID integration**

   * Integration with one DID resolver for Midnight (for example Midnames or another DID service).
   * Ability to:

     * Resolve issuer DID from the token or registry.
     * Fetch the DID Document.
     * Read `credentials` and `credentialProof` for further checks if needed.

4. **Responsive Verifier web app**

   * Web user interface where a verifier can:

     * Paste or scan a token.
     * Trigger `/verify`.
     * See clear result including status, reason code and high level issuer information.
   * History view of recent verifications for debugging or demo purposes.

### Definition of done

* Verification backend runs in a test environment and can:

  * Successfully verify a token generated by the SDK.
  * Correctly reject invalid tokens.
* KYB registry is integrated and used in the decision logic.
* DID resolution works for at least one real test DID on Midnight testnet.
* Verifier web app is responsive and fully functional on desktop and mobile.
* Basic metrics exist for:

  * Number of verification requests.
  * Error rate.
  * p95 latency.

---

## 6. Testnet Deployment, Monitoring and Documentation

**Deploy smart contracts on Midnight testnet, validate data flows, and implement monitoring and logging.**

### What must be built and executed

1. **Deployment automation for testnet**

   * Scripts or pipelines that:

     * Deploy the staking and Merkle commitment contracts on Midnight testnet.
     * Register at least one test validator and fund the stake.
     * Commit at least one test Merkle root.

2. **End to end flow validation**

   * At least two complete end to end scenarios documented and executed:

     1. Age proof scenario.
     2. KYC status proof scenario.

   For each scenario:

   * Document creation.
   * Proof Document and token generation in the wallet using the SDK.
   * Token verification through the web app and backend.
   * On chain checks of Merkle roots and any relevant contract state.

3. **Monitoring and logging**

   * Metrics collection for the verification service, for example:

     * Total requests.
     * Success and failure counts.
     * Latency distribution.
   * Structured logging with correlation IDs.
   * Explicit policy that no PII is logged, only pseudonymous identifiers such as hashes and DIDs.

4. **Documentation**

   * Technical documentation for developers:

     * How to deploy contracts on Midnight testnet.
     * How to configure and run the verification service.
     * How to integrate the SDK in a wallet or application.
   * Operations runbook:

     * Steps for redeploy.
     * How to add a new test issuer or validator.
     * How to investigate failed verifications.

### Definition of done

* All required contracts are live on Midnight testnet and their addresses are documented.
* At least two end to end flows have been demonstrated and recorded as reference scenarios.
* Monitoring dashboards exist and show live data from the verification service.
* Documentation is in a shared repository or knowledge base and is ready to be attached to the grant or shared with Midnight engineers.
