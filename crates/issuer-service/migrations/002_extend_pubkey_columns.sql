-- Extend public key columns to support P-256 keys (130 hex chars)
-- Ed25519 = 64 chars, P-256 uncompressed = 130 chars

ALTER TABLE issued_credentials
    ALTER COLUMN issuer_public_key TYPE VARCHAR(256),
    ALTER COLUMN owner_public_key TYPE VARCHAR(256);

ALTER TABLE issued_credentials
    ALTER COLUMN root_hash TYPE VARCHAR(256);
