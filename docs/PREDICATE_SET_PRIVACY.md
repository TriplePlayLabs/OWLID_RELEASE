# Verifier-supplied set membership — privacy design

Where the allowed-set for OwlID's `residency_in` / `nationality_in` predicates
lives on Midnight, and why.

## TL;DR

The allowed-set is a **witness**. The on-chain footprint of one attestation
is one 32-byte `setHash` (in the public-arg) and the resulting 32-byte
attestation key — never the country codes themselves, never the holder's
country.

`setHash` is salted with the **verifier's OID4VP `client_id`** so two
verifiers asking for the same allowed-set under the same credential
produce distinct on-chain keys. Cross-verifier rainbow tables on
well-known policies (EU-27, OFAC, …) cannot link verifiers; the cost is
that attestation reuse is now **per-verifier**, not global.

The on-chain attestation key remains
`SHA-256(tag || rootHash || setHash)`, so a credential's residency
attestation against the EU-27 set under verifier A stays distinct from
the same credential's attestation against {NL, BE, DE} under the same
verifier, or against EU-27 under verifier B.

## Threat model

Adversary = anyone observing the public Midnight chain transcript and
indexer.

| Asset                                                         | Defended                                                                                                                                                                                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Holder's residence / nationality country                      | Yes — witness, never disclosed                                                                                                                                                                                                           |
| Holder's credential rootHash → identity linkage               | Yes — rootHash is per-credential, never linked to the holder's wallet                                                                                                                                                                    |
| Verifier's allowed-set bytes                                  | Yes — set is a witness, only the SHA-256-derived `setHash` is on chain                                                                                                                                                                   |
| Whether a credential satisfies one specific verifier's policy | **No** — a verifier (or anyone who knows the verifier's `client_id`) can re-derive `setHash` from any guessed policy and check membership in the attestation set. The adversary must guess the policy AND know the verifier identity.    |
| Whether two verifiers share the same allowed-set              | Yes — `setHash` depends on each verifier's `client_id`, so the same policy under two verifiers yields two distinct keys                                                                                                                  |
| Whether a credential has been attested at all                 | No — the per-credential `rootHash` is one of the three inputs to the on-chain key. An adversary who knows the credential's rootHash (the holder discloses this to issuers + verifiers anyway) can enumerate against well-known policies. |

## Decision

### Contract shape

```compact
witness residentCountry(): Bytes<32>;
witness allowedCountrySet(): Vector<64, Bytes<32>>;
witness verifierIdHash(): Bytes<32>;

export circuit attestResidencyIn(
  rootHash: Bytes<32>,
  setHash:  Bytes<32>
): [] {
  const allowed = allowedCountrySet();
  const vId     = verifierIdHash();
  const country = residentCountry();

  const setBody  = persistentHash<Vector<64, Bytes<32>>>(disclose(allowed));
  const computed = persistentHash<Vector<2, Bytes<32>>>([disclose(vId), setBody]);
  assert(setHash == computed, "setHash mismatch");

  const inSet = fold((acc, slot) => acc || (slot == country), false, allowed);
  assert(inSet, "residence country not in allowed set");

  record(keyOf(pad(32, "owlid:attest:resin:"),
               disclose(rootHash), disclose(setHash)));
}
```

`predicate_nationality.compact` follows the same shape with the
`owlid:attest:nat:` tag and `nationalityCode()` witness.

### `setHash` recipe

Computed identically off-chain and on:

```
verifierIdHash = SHA-256(verifier_client_id_utf8)
setBody        = SHA-256( pad32(c0) || pad32(c1) || ... || pad32(c63) )
setHash        = SHA-256( verifierIdHash || setBody )
```

Verifier and holder must agree on the canonical form of the allowed
set — see Canonicalisation below.

### Set size — 64

| N (slots) | SHA-256 blocks for `persistentHash<Vector<N, Bytes<32>>>` | Covers                                                                  |
| --------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| 16        | 9                                                         | single-country queries, small bilaterals                                |
| 32        | 17                                                        | EU-27 + EEA                                                             |
| **64**    | **33**                                                    | EU-27 + EEA + DACH + Nordics + Benelux + most country lists in the wild |
| 128       | 65                                                        | unusual policy lists                                                    |
| 256       | 129                                                       | covers ISO 3166-1 alpha-2 (~249) with headroom                          |

Real verifier policies almost never exceed 30 codes (EU-27 + 3 EEA = 30).
N=64 gives 2× headroom while keeping the in-circuit SHA-256 modest. All
OwlID set-membership circuits use the same N so the circuit shape is
constant — no fingerprinting by set size.

Larger N is not blocked by Midnight block weight (75% of 2 s ref-time,
~768 KiB normal-class extrinsic — see
`midnight-node/runtime/src/lib.rs:305-318`). The pressure is holder-side
proving time on a phone / browser; doubling N doubles the SHA-256 cost
inside the circuit. N=64 is the sweet spot for OwlID's UX.

### Verifier identity

The OID4VP `client_id` (the verifier's stable identifier — typically
its response_uri or deployment origin). The verifier-app derives it from
`window.location.origin`; the same string is sent on the wire in the
`PresentationRequest` for the holder, and re-supplied by the verifier
backend when it calls `/predicates/attested` for the membership check.

Mismatched verifier ids on the holder and verifier sides produce
different `setHash` values → different on-chain keys → membership miss
→ predicate fails. The verification-service rejects nationality_in /
resident_in claims with no `verifierId` outright.

### Canonicalisation

Off-chain, both verifier and holder produce `setHash` from the same
inputs the same way:

1. Accept user input (alpha-2 codes, mixed case, with separators).
2. Normalise to uppercase ASCII alpha-2.
3. Drop duplicates and invalid codes.
4. **Sort lexicographically.**
5. Right-pad each code to 32 bytes (`pad(32, "NL")` shape).
6. Append zero-hash slots until length = 64.
7. Compute `setBody = SHA-256(slot_0 || slot_1 || ... || slot_63)`.
8. `setHash = SHA-256( SHA-256(verifier_client_id) || setBody )`.

Steps 3–6 are what make `setHash` content-addressed: any reordering or
duplication produces the same hash. Without sort + dedupe, a verifier
asking the same set twice in different orders would emit two different
on-chain keys, defeating same-verifier reuse.

The canonicalisation lives in three mirrored implementations:

- Rust: `owl_proof_system::attestation::{canonicalise_countries,
allowed_country_set_hash}` (the source of truth — used by the
  verification-service and bound into the tests).
- TypeScript SDK (wallet side): `packages/sdk/src/midnight/orchestrator.ts`
  (`canonicaliseCountries`, `computeSetHash`).
- TypeScript sidecar: `packages/midnight-sidecar/src/routes/predicates.ts`
  (`buildSetMembership` — same shape, used by the legacy sidecar attest
  endpoints).

If any one of them drifts the on-chain key won't match across boundaries.

### What stays the same

- One contract per predicate kind (`predicate_residency`,
  `predicate_nationality`). Two new contract addresses because the
  circuit shape changes; old addresses are dead.
- The SSE attestation-set mirror in the sidecar is still the
  authoritative source of truth on the verifier side. The verification-
  service looks up `attestations.member(SHA-256(tag || rootHash ||
setHash))` — same recipe, just shorter param.
- DCQL stays standard. The verifier-app passes `claim.values =
[["NL","BE","DE"]]` exactly as today; the wallet's SDK canonicalises
  and computes `setHash` before calling the orchestrator.

## Why not …

### … keep `allowedCountries` as a public arg?

Three independent research streams (Midnight skills, ZK identity
standards, adjacent ecosystems) converged against it:

- **Midnight idiom**: the canonical anonymous-set primitive is a
  witness-supplied set-membership proof. Public Vector + fold is correct
  Compact but not idiomatic and leaks the policy bytes in the
  transcript.
- **Standards consensus**: no standard surveyed (W3C VCDM 2.0, EUDI
  ARF, ISO 18013-7, OID4VP/DCQL, SD-JWT VC, AnonCreds) puts verifier
  predicate parameter _values_ on chain. The closest precedent for
  on-chain bounds (Rarimo) only does it for audit-relevant universal
  values (date windows, identity counters) — never arbitrary verifier
  choice sets.
- **Ecosystem precedent**: zkPassport (the closest domain match — Noir
  passport circuits) keeps the country list in the witness and emits a
  Poseidon param-commitment as the public output; Iden3 V3OnChain
  collapses the whole query into a single `queryHash` to keep on-chain
  inputs small. Both refuse to publish the raw set.

### … use a `HistoricMerkleTree` of valid country codes?

Cheaper in the circuit (1 SHA-256 + log₂N transient hashes vs. 1
SHA-256 over N×32 bytes) — but loses the per-policy binding cleanly.
Either you keep one tree per policy (ledger storage explodes) or you
fold the policy hash into the on-chain key off-tree (which is exactly
what this design already does, minus the unnecessary tree). For N ≤ 64
the flat witness Vector is simpler, costs less ledger storage, and
matches the zkPassport pattern.

### … keep cross-verifier attestation reuse?

Without the per-verifier salt, an attestation against `{NL, BE, DE}`
holds for every verifier asking the same set — one proof, infinite
reuse. With salt, the holder re-attests per verifier (one tx per
verifier × policy). Cost: more on-chain attestation txs over a
credential's lifetime (each is ~30 s of holder-device proving plus the
sidecar relay).

The reuse loss buys two concrete privacy properties:

1. **No global rainbow table over well-known policies.** Without salt
   the EU-27 hash is a single, globally-recognisable fingerprint on
   chain. With salt, an attacker would need to grind `(verifier_id,
policy)` pairs per credential.
2. **Verifier-to-verifier unlinkability of usage.** Without salt, two
   verifiers asking the same policy share the on-chain key — so they
   can cross-reference which credentials they have both attested.
   With salt, that channel is closed.

OwlID's threat model treats the holder's privacy as the load-bearing
property, so we pay the reuse cost.

## Migration from the 32-slot public-arg deploy

The current deploy (commit `d273dfe`) shipped
`attestResidencyIn(rootHash, allowedCountries: Vector<32, Bytes<32>>)` at
fresh addresses. The witness-in redesign requires another fresh deploy
at new addresses again. Steps:

1. `just compact && just sync-midnight-assets` — rebuilds the contracts,
   regenerates the TS types, copies them into the SDK.
2. `cargo check --workspace` + per-package `bun tsc` — confirm the new
   `verifierId` plumbing type-checks end-to-end.
3. `CONTRACTS=predicate_residency,predicate_nationality bun run --cwd
packages/midnight-sidecar deploy` — produces two new addresses.
4. Update `.env` + `deploy/gcp/terraform/terraform.tfvars` with the new
   addresses. The env-var names
   (`MIDNIGHT_PREDICATE_{RESIDENCY,NATIONALITY}_ADDRESS`) stay.
5. `terraform apply -target=google_cloud_run_v2_service.sidecar` to push
   the new addresses into Cloud Run.
6. Build + roll all five services (`gcloud builds submit` ×5 →
   `gcloud run services update <svc> --image=...:latest` ×5).
7. Live E2E against `wallet.owlid.app` + `verifier.owlid.app`:
   - Single-country query (NL only)
   - EU-27 query
   - DACH query (3 codes)
   - A 60-code query (near the cap)
8. The old contract addresses at residency/nationality are abandoned —
   the circuit shape changed, so no on-chain migration is possible.

Existing credentials with `country` populated via the alpha-2 backfill
in `walletCredentialToProofJson` (commit `ef2bea7`) continue to work
without re-issuance — only the predicate contracts change.

## Future work (open)

1. **Off-chain audit registry.** A separate sidecar endpoint where a
   verifier may publish `(setHash, set)` voluntarily so regulators or
   auditors can resolve well-known policy hashes — without forcing the
   set on chain. Mirrors Privacy Pools' ASP design.
2. **Larger N if a real verifier needs it.** Add `attestResidencyIn256`
   alongside the N=64 variant if a verifier ships a policy with >64
   codes. The tag namespace already supports per-variant separation.
3. **EUDI ARF §3.11.1 attribute-type pre-registration.** The current
   model lets any verifier ask any allowed-set; an ARF-compliant
   deployment would gate the attest endpoint by a verifier registry.
   Out of scope until OwlID enters an EUDI trust framework.
