-- Seed data for development and testing
-- This file should NOT be run in production

-- Default dev API key. Format: `owlid_sk_test_dev0000…0000`. Test env so
-- it cannot be confused with a live key. Replace before exposing the
-- service to anything outside localhost.
INSERT INTO api_keys (
    key_hash, name, description, permissions, created_by,
    key_type, environment, key_preview
)
VALUES (
    'f0b838a75d5ad3403095fac59e01581f365cb39ccddaed08b7c15b51e26c8c9c', -- SHA256 of 'owlid_sk_test_dev0000000000000000000000000000000000000000'
    'Development Key',
    'Default API key for local development',
    '["verify", "manage_issuers", "manage_revocations", "admin", "gdpr"]'::jsonb,
    'system',
    'sk',
    'test',
    'owlid_sk_test_de…0000'
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
