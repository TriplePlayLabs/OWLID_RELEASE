-- 002_seed.sql says "should NOT be run in production", but sqlx applies
-- every numbered migration, so the dev API key and the well-known
-- "Test Issuer" public key landed in production too. A verifier that
-- trusts the test issuer key accepts credentials anyone can mint, so
-- remove the dev seed everywhere. Nothing in dev relies on these rows:
-- the verification-service provisions API keys from env at startup
-- (`ensure_configured_api_key` — VERIFIER_API_KEY / API_KEY_DEV) and the
-- issuer-service self-registers as a trusted issuer.

DELETE FROM trusted_issuers
WHERE public_key = 'test_issuer_pubkey_1234567890abcdef1234567890abcdef';

DELETE FROM api_keys
WHERE key_hash = 'f0b838a75d5ad3403095fac59e01581f365cb39ccddaed08b7c15b51e26c8c9c';

-- The sample dashboard metrics row from the seed (exact value match).
DELETE FROM verification_metrics
WHERE total_verifications = 100
  AND successful_verifications = 95
  AND failed_verifications = 5
  AND unique_verifiers = 10
  AND avg_response_time_ms = 15.5;
