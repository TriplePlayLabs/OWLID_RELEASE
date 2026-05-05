-- Operator-tunable runtime settings. One row per key. Values stored as
-- JSONB so a setting can be a bool, a number, or a small object without
-- adding a new column. Keep the surface tiny — anything that warrants a
-- proper table (api keys, issuers, revocations) gets its own.
--
-- Initial keys:
--   midnight_enabled (bool) — controls whether the Midnight sidecar
--   integration is active for chain-bound operations. Defaults to the
--   value of MIDNIGHT_ENABLED from env on first boot, then admin can
--   toggle live via /admin/midnight/{enable,disable}.

CREATE TABLE IF NOT EXISTS system_settings (
    key         TEXT        PRIMARY KEY,
    value       JSONB       NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by  TEXT
);
