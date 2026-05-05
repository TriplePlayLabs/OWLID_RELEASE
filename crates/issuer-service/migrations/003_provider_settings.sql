-- Per-provider operator overrides. One row per registered provider that has
-- ever been toggled; absence means default behaviour (enabled). Splitting
-- this from `system_settings` keeps the per-provider audit columns close
-- to the data and avoids encoding a full map in a single JSONB blob.

CREATE TABLE IF NOT EXISTS provider_settings (
    provider_id TEXT        PRIMARY KEY,
    enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by  TEXT
);
