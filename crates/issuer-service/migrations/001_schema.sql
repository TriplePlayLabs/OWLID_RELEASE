-- Issuer Service Schema
-- Credential issuance and identity provider integration

-- Issued credentials registry
CREATE TABLE issued_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    root_hash VARCHAR(128) NOT NULL UNIQUE, -- Merkle root hash of the credential
    issuer_public_key VARCHAR(128) NOT NULL,
    owner_public_key VARCHAR(128) NOT NULL,
    credential_data JSONB NOT NULL, -- The full ProofDocument serialized as JSON
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ, -- Optional expiration
    is_active BOOLEAN NOT NULL DEFAULT true,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_issued_credentials_root_hash ON issued_credentials(root_hash);
CREATE INDEX idx_issued_credentials_issuer ON issued_credentials(issuer_public_key);
CREATE INDEX idx_issued_credentials_owner ON issued_credentials(owner_public_key);
CREATE INDEX idx_issued_credentials_active ON issued_credentials(is_active);
CREATE INDEX idx_issued_credentials_expires ON issued_credentials(expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON TABLE issued_credentials IS 'Registry of issued credentials for tracking and management';
COMMENT ON COLUMN issued_credentials.issuer_public_key IS 'Public key of the issuer - trust verified separately by verification service';

-- ============================================================================
-- Identity Provider Tables
-- Supports Apple Sign-In, Google OAuth, and WebAuthn passkeys
-- ============================================================================

-- Central user registry for OwlID
CREATE TABLE owl_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email_hash VARCHAR(64) UNIQUE, -- SHA256 hash of email for privacy
    display_name VARCHAR(255),
    avatar_url VARCHAR(512),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_owl_users_email_hash ON owl_users(email_hash) WHERE is_active = true;
CREATE INDEX idx_owl_users_active ON owl_users(is_active);

-- External IdP to OwlID user mapping
CREATE TABLE idp_user_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES owl_users(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL, -- 'google', 'apple', 'webauthn'
    provider_user_id VARCHAR(255) NOT NULL, -- External user ID (sub claim)
    provider_email_hash VARCHAR(64), -- SHA256 hash of email from provider
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}', -- Stores non-PII provider data (locale, etc.)
    CONSTRAINT unique_provider_user UNIQUE (provider, provider_user_id)
);

CREATE INDEX idx_idp_mappings_user ON idp_user_mappings(user_id);
CREATE INDEX idx_idp_mappings_provider ON idp_user_mappings(provider, provider_user_id);

-- WebAuthn credentials storage (server-side passkey data)
CREATE TABLE webauthn_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES owl_users(id) ON DELETE CASCADE,
    credential_id VARCHAR(512) NOT NULL UNIQUE, -- Base64-encoded credential ID
    public_key VARCHAR(512) NOT NULL, -- Base64-encoded COSE public key
    counter BIGINT NOT NULL DEFAULT 0, -- Signature counter for replay protection
    transports JSONB DEFAULT '[]', -- ['usb', 'nfc', 'ble', 'internal']
    device_name VARCHAR(255), -- User-friendly device name
    aaguid VARCHAR(36), -- Authenticator attestation GUID
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_webauthn_credentials_user ON webauthn_credentials(user_id) WHERE is_active = true;
CREATE INDEX idx_webauthn_credentials_cred_id ON webauthn_credentials(credential_id);

-- Authentication sessions
CREATE TABLE auth_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES owl_users(id) ON DELETE CASCADE,
    session_token_hash VARCHAR(64) NOT NULL UNIQUE, -- SHA256 hash of session token
    provider VARCHAR(50) NOT NULL, -- Auth method used: 'google', 'apple', 'webauthn'
    ip_address INET,
    user_agent TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_auth_sessions_token ON auth_sessions(session_token_hash) WHERE is_active = true;
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id, is_active);
CREATE INDEX idx_auth_sessions_expires ON auth_sessions(expires_at) WHERE is_active = true;

-- Credentials issued from IdP claims (auto-issuance tracking)
CREATE TABLE idp_issued_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES owl_users(id) ON DELETE CASCADE,
    credential_root_hash VARCHAR(128) NOT NULL, -- Links to issued_credentials table
    idp_provider VARCHAR(50) NOT NULL, -- Source IdP
    claim_types JSONB NOT NULL, -- Which claims were used: ['email', 'name', 'picture']
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_idp_issued_credentials_user ON idp_issued_credentials(user_id);
CREATE INDEX idx_idp_issued_credentials_root ON idp_issued_credentials(credential_root_hash);

-- WebAuthn challenge storage (short-lived, for registration/authentication)
CREATE TABLE webauthn_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    challenge VARCHAR(255) NOT NULL UNIQUE, -- Base64-encoded challenge
    user_id UUID REFERENCES owl_users(id) ON DELETE CASCADE, -- NULL for registration
    operation VARCHAR(20) NOT NULL CHECK (operation IN ('register', 'authenticate')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
    used_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_webauthn_challenges_challenge ON webauthn_challenges(challenge) WHERE used_at IS NULL;
CREATE INDEX idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);

-- OAuth state storage (CSRF protection for OAuth flow)
CREATE TABLE oauth_states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state VARCHAR(128) NOT NULL UNIQUE, -- Random state parameter
    provider VARCHAR(50) NOT NULL, -- 'google', 'apple'
    code_verifier VARCHAR(128), -- PKCE code verifier
    redirect_uri VARCHAR(512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
    used_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_oauth_states_state ON oauth_states(state) WHERE used_at IS NULL;
CREATE INDEX idx_oauth_states_expires ON oauth_states(expires_at);

-- Updated at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Updated at trigger for owl_users
CREATE TRIGGER update_owl_users_updated_at
    BEFORE UPDATE ON owl_users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Function to clean up expired auth data
CREATE OR REPLACE FUNCTION cleanup_auth_data()
RETURNS void AS $$
BEGIN
    -- Deactivate expired sessions
    UPDATE auth_sessions
    SET is_active = false, revoked_at = NOW()
    WHERE expires_at < NOW() AND is_active = true;

    -- Delete old expired sessions (keep for audit trail for 30 days)
    DELETE FROM auth_sessions
    WHERE is_active = false AND revoked_at < NOW() - INTERVAL '30 days';

    -- Delete expired WebAuthn challenges
    DELETE FROM webauthn_challenges WHERE expires_at < NOW();

    -- Delete expired OAuth states
    DELETE FROM oauth_states WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Comments for documentation
COMMENT ON TABLE owl_users IS 'Central user registry - stores only hashed PII';
COMMENT ON TABLE idp_user_mappings IS 'Maps external IdP users to OwlID users';
COMMENT ON TABLE webauthn_credentials IS 'Server-side passkey storage for WebAuthn';
COMMENT ON TABLE auth_sessions IS 'User authentication sessions with expiry';
COMMENT ON TABLE idp_issued_credentials IS 'Tracks credentials auto-issued from IdP claims';
COMMENT ON TABLE webauthn_challenges IS 'Short-lived challenges for WebAuthn ceremonies';
COMMENT ON TABLE oauth_states IS 'CSRF protection state for OAuth flows';
