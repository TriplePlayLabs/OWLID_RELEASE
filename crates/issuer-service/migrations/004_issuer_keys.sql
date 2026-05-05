-- Persisted issuer keypairs.
--
-- Boot resolution order:
--   1. ISSUER_PRIVATE_KEY env wins — operator-managed (prod).
--   2. Else look up the most recent active row here and reuse it.
--   3. Else generate a fresh keypair and insert a row.
--
-- Without this table, every issuer-service restart minted a new key and
-- the verification-service's `trusted_issuers` registry no longer knew
-- about it, so previously-issued credentials immediately became
-- "Untrusted issuer".
--
-- Storing the private key hex in plain text is fine for the PoC dev
-- environment but obviously not for production — there, the operator
-- supplies the key via env (path 1) and this table is never written.

CREATE TABLE IF NOT EXISTS issuer_keys (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    public_key_hex  TEXT        NOT NULL UNIQUE,
    private_key_hex TEXT        NOT NULL,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    retired_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_issuer_keys_active
    ON issuer_keys(is_active, created_at DESC);
