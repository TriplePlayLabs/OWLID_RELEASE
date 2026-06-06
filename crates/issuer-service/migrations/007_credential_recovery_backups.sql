CREATE TABLE credential_recovery_backups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id VARCHAR(80) NOT NULL,
    subject_hash VARCHAR(64) NOT NULL,
    credential_id VARCHAR(128) NOT NULL,
    ciphertext TEXT NOT NULL,
    encryption_version VARCHAR(40) NOT NULL,
    key_label VARCHAR(80) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    restored_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT unique_recovery_backup UNIQUE (provider_id, subject_hash, credential_id)
);

CREATE INDEX idx_recovery_backups_subject
    ON credential_recovery_backups(provider_id, subject_hash);

