-- Verification Service Schema
-- GDPR compliant with audit trails and data lifecycle management

-- API Keys for authentication.
-- Format: `owlid_{pk|sk}_{live|test}_<base62>`.
--   pk = publishable (browser-safe, scoped to `verify`)
--   sk = secret (server-only, any permission)
-- key_hash stores SHA-256 of the full key and is the lookup index.
-- key_preview is a redacted display string (`owlid_sk_live_…AbCd`).
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash VARCHAR(64) NOT NULL UNIQUE,
    key_type VARCHAR(8) NOT NULL,
    environment VARCHAR(8) NOT NULL,
    key_preview VARCHAR(48) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    permissions JSONB NOT NULL DEFAULT '[]',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_by VARCHAR(255),
    CONSTRAINT valid_expiry CHECK (expires_at IS NULL OR expires_at > created_at),
    CONSTRAINT api_keys_type_check CHECK (key_type IN ('pk', 'sk')),
    CONSTRAINT api_keys_env_check  CHECK (environment IN ('live', 'test'))
);

CREATE INDEX idx_api_keys_hash    ON api_keys(key_hash) WHERE is_active = true;
CREATE INDEX idx_api_keys_active  ON api_keys(is_active, expires_at);
CREATE INDEX idx_api_keys_type_env ON api_keys(key_type, environment) WHERE is_active = true;

-- Trusted issuers registry
CREATE TABLE trusted_issuers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    public_key VARCHAR(128) NOT NULL UNIQUE, -- Hex-encoded Ed25519 public key
    name VARCHAR(255) NOT NULL,
    description TEXT,
    issuer_url VARCHAR(512),
    is_active BOOLEAN NOT NULL DEFAULT true,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    added_by VARCHAR(255),
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_trusted_issuers_pubkey ON trusted_issuers(public_key) WHERE is_active = true;
CREATE INDEX idx_trusted_issuers_active ON trusted_issuers(is_active);

-- Revocation registry with GDPR-compliant data retention
CREATE TABLE revocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    credential_id VARCHAR(255) NOT NULL UNIQUE, -- Hash or identifier of the credential
    issuer_public_key VARCHAR(128) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('revoked', 'suspended', 'active')),
    reason TEXT,
    revoked_at TIMESTAMPTZ,
    suspended_at TIMESTAMPTZ,
    reactivated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ, -- Auto-delete after this date for GDPR compliance
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_revocations_credential ON revocations(credential_id, status);
CREATE INDEX idx_revocations_issuer ON revocations(issuer_public_key);
CREATE INDEX idx_revocations_status ON revocations(status);
CREATE INDEX idx_revocations_expires ON revocations(expires_at) WHERE expires_at IS NOT NULL;

-- Verification logs (immutable audit trail)
-- Stores only hashed proof data for GDPR compliance
CREATE TABLE verification_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proof_hash VARCHAR(64) NOT NULL, -- SHA256 hash of the proof
    challenge_hash VARCHAR(64) NOT NULL, -- SHA256 hash of the challenge
    issuer_public_key VARCHAR(128),
    verification_result VARCHAR(20) NOT NULL CHECK (verification_result IN ('success', 'failed')),
    failure_reason TEXT,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    verifier_id VARCHAR(255), -- Identifier of the verifying party
    ip_address INET, -- For rate limiting and abuse detection
    user_agent TEXT,
    metadata JSONB DEFAULT '{}',
    -- GDPR: Auto-expire after retention period
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days')
);

CREATE INDEX idx_verification_logs_timestamp ON verification_logs(verified_at DESC);
CREATE INDEX idx_verification_logs_result ON verification_logs(verification_result);
CREATE INDEX idx_verification_logs_issuer ON verification_logs(issuer_public_key);
CREATE INDEX idx_verification_logs_expires ON verification_logs(expires_at);
CREATE INDEX idx_verification_logs_ip ON verification_logs(ip_address, verified_at); -- For rate limiting

-- Metrics aggregation (for performance dashboards)
CREATE TABLE verification_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    total_verifications BIGINT NOT NULL DEFAULT 0,
    successful_verifications BIGINT NOT NULL DEFAULT 0,
    failed_verifications BIGINT NOT NULL DEFAULT 0,
    unique_verifiers INTEGER NOT NULL DEFAULT 0,
    avg_response_time_ms NUMERIC(10, 2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_period UNIQUE (period_start, period_end)
);

CREATE INDEX idx_metrics_period ON verification_metrics(period_start DESC, period_end DESC);

-- GDPR: Automatic data deletion function
CREATE OR REPLACE FUNCTION delete_expired_records()
RETURNS void AS $$
BEGIN
    -- Delete expired verification logs
    DELETE FROM verification_logs WHERE expires_at < NOW();

    -- Delete expired revocations
    DELETE FROM revocations WHERE expires_at IS NOT NULL AND expires_at < NOW();

    -- Delete expired API keys
    UPDATE api_keys SET is_active = false
    WHERE expires_at IS NOT NULL AND expires_at < NOW() AND is_active = true;
END;
$$ LANGUAGE plpgsql;

-- Audit trail for compliance
CREATE TABLE audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(50) NOT NULL, -- 'issuer_added', 'credential_revoked', etc.
    entity_type VARCHAR(50) NOT NULL, -- 'issuer', 'revocation', 'api_key'
    entity_id VARCHAR(255) NOT NULL,
    actor VARCHAR(255), -- Who performed the action
    action_hash VARCHAR(64) NOT NULL, -- SHA256 hash of the action details
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_audit_events_type ON audit_events(event_type, occurred_at DESC);
CREATE INDEX idx_audit_events_entity ON audit_events(entity_type, entity_id);
CREATE INDEX idx_audit_events_timestamp ON audit_events(occurred_at DESC);

-- Rate limiting table
CREATE TABLE rate_limits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    identifier VARCHAR(255) NOT NULL, -- IP address or API key hash
    endpoint VARCHAR(255) NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 1,
    window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    window_end TIMESTAMPTZ NOT NULL,
    CONSTRAINT unique_rate_limit UNIQUE (identifier, endpoint, window_start)
);

CREATE INDEX idx_rate_limits_identifier ON rate_limits(identifier, window_end);
CREATE INDEX idx_rate_limits_cleanup ON rate_limits(window_end);

-- Function to clean up old rate limit records
CREATE OR REPLACE FUNCTION cleanup_rate_limits()
RETURNS void AS $$
BEGIN
    DELETE FROM rate_limits WHERE window_end < NOW() - INTERVAL '1 hour';
END;
$$ LANGUAGE plpgsql;

-- Updated at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_revocations_updated_at
    BEFORE UPDATE ON revocations
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE api_keys IS 'API keys for authentication - stores only hashed keys';
COMMENT ON TABLE trusted_issuers IS 'Registry of trusted credential issuers';
COMMENT ON TABLE revocations IS 'Credential revocation status with GDPR-compliant expiry';
COMMENT ON TABLE verification_logs IS 'Immutable audit trail of verification attempts - stores only hashed data';
COMMENT ON TABLE verification_metrics IS 'Aggregated metrics for performance monitoring';
COMMENT ON TABLE audit_events IS 'GDPR-compliant audit trail with hashed action details';
COMMENT ON TABLE rate_limits IS 'Rate limiting data for API abuse prevention';
