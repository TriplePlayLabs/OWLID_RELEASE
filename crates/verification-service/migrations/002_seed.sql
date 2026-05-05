-- Seed data for development and testing
-- This file should NOT be run in production

-- Create a default API key for development
-- Key: dev_key_12345678901234567890123456789012
-- Hash: SHA256 of the above key
INSERT INTO api_keys (key_hash, name, description, permissions, created_by)
VALUES (
    '2a64efd40ea1ddbfd7c096bbc1977d149d7408f1796283eb968507d8b85b28a2', -- SHA256 of 'dev_key_12345678901234567890123456789012'
    'Development Key',
    'Default API key for local development',
    '["verify", "manage_issuers", "manage_revocations", "admin"]'::jsonb,
    'system'
)
ON CONFLICT (key_hash) DO NOTHING;

-- Add a sample trusted issuer for testing
-- This is a test key - replace with real issuer keys in production
INSERT INTO trusted_issuers (public_key, name, description, added_by)
VALUES (
    'test_issuer_pubkey_1234567890abcdef1234567890abcdef',
    'Test Issuer',
    'Sample issuer for development and testing',
    'system'
)
ON CONFLICT (public_key) DO NOTHING;

-- Insert sample metrics for dashboard testing
INSERT INTO verification_metrics (
    period_start,
    period_end,
    total_verifications,
    successful_verifications,
    failed_verifications,
    unique_verifiers,
    avg_response_time_ms
)
VALUES (
    NOW() - INTERVAL '1 hour',
    NOW(),
    100,
    95,
    5,
    10,
    15.5
);
