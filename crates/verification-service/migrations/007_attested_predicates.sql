-- Midnight-native predicate attestations mirrored from the sidecar
-- /events SSE stream (predicate_registry `attestations` Set). One row
-- per attestation key = persistentHash(tag || rootHash || param).
-- /verify checks membership here instead of verifying a ZK proof
-- inline; the Midnight node already verified the proof in consensus.

CREATE TABLE IF NOT EXISTS attested_predicates (
    attest_key  TEXT PRIMARY KEY,
    attested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE attested_predicates IS
    'Chain-attested predicate keys mirrored via sidecar SSE; verifier checks membership instead of inline ZK verify';
