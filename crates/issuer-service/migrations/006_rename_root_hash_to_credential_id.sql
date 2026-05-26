-- The `root_hash` columns predate the SD-JWT VC refactor — they no longer
-- store a Merkle root, they store the credential id (raw 32-byte hex). Rename
-- so the schema matches the data.

ALTER TABLE issued_credentials
    RENAME COLUMN root_hash TO credential_id;

ALTER INDEX idx_issued_credentials_root_hash
    RENAME TO idx_issued_credentials_credential_id;

ALTER TABLE idp_issued_credentials
    RENAME COLUMN credential_root_hash TO credential_id;

ALTER INDEX idx_idp_issued_credentials_root
    RENAME TO idx_idp_issued_credentials_credential_id;
