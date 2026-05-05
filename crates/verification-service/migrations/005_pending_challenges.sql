-- Server-generated challenges for secure verification flow.
-- Verifier requests a challenge, server stores it with TTL.
-- When the token is verified, the challenge must exist here.

CREATE TABLE IF NOT EXISTS pending_challenges (
    challenge VARCHAR(64) PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
    used BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_pending_challenges_expires ON pending_challenges(expires_at);

COMMENT ON TABLE pending_challenges IS 'Server-generated challenges for FIDO2-style verification freshness';
