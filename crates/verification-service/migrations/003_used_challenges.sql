-- T-011: Challenge replay protection
-- Stores hashed challenges to prevent token replay attacks.
-- Expired entries are cleaned up periodically.

CREATE TABLE IF NOT EXISTS used_challenges (
    challenge_hash VARCHAR(64) PRIMARY KEY,
    used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour')
);

CREATE INDEX idx_used_challenges_expires ON used_challenges(expires_at);

COMMENT ON TABLE used_challenges IS 'Tracks used verification challenges to prevent replay attacks';
