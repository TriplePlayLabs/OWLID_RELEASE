//! End-to-end API tests for the OwlID Issuer Service.
//!
//! Covers: session management, identity verification via mock providers,
//! credential issuance, provider listing, and OIDC endpoints.
//!
//! Prerequisites: Issuer service running on port 8001 with mock providers.
//! Run with: cargo test -p owl-issuer-service --test e2e_api -- --ignored --test-threads=1

use reqwest::Client;
use serde_json::{json, Value};

struct TestServer {
    base_url: String,
    client: Client,
}

impl TestServer {
    async fn new() -> Self {
        let base_url = std::env::var("ISSUER_SERVICE_URL")
            .unwrap_or_else(|_| "http://localhost:8001".to_string());
        let client = Client::new();
        let server = TestServer { base_url, client };

        let resp = server.get("/health").await;
        assert_eq!(
            resp.status(),
            200,
            "Issuer service not running at {}",
            server.base_url
        );
        server
    }

    async fn get(&self, path: &str) -> reqwest::Response {
        self.client
            .get(format!("{}{}", self.base_url, path))
            .send()
            .await
            .expect("HTTP request failed")
    }

    async fn post(&self, path: &str, body: &Value) -> reqwest::Response {
        self.client
            .post(format!("{}{}", self.base_url, path))
            .json(body)
            .send()
            .await
            .expect("HTTP request failed")
    }
}

// ==========================================================================
// Health & Info
// ==========================================================================

#[tokio::test]
#[ignore]
async fn test_health() {
    let server = TestServer::new().await;
    let resp = server.get("/health").await;
    assert_eq!(resp.status(), 200);
    let body = resp.text().await.unwrap();
    assert!(body.contains("running"), "Health should indicate running");
}

#[tokio::test]
#[ignore]
async fn test_issuer_info() {
    let server = TestServer::new().await;
    let resp = server.get("/issuer-info").await;
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().await.unwrap();
    assert!(
        body["publicKey"].is_string(),
        "Should return issuer public key"
    );
    assert!(body["name"].is_string(), "Should return issuer name");
    // Public key should be hex
    let pk = body["publicKey"].as_str().unwrap();
    assert!(pk.len() >= 32, "Public key should be at least 32 hex chars");
}

// ==========================================================================
// Provider Listing
// ==========================================================================

#[tokio::test]
#[ignore]
async fn test_list_providers() {
    let server = TestServer::new().await;
    let resp = server.get("/providers").await;
    assert_eq!(resp.status(), 200);
    let body: Vec<Value> = resp.json().await.unwrap();
    assert!(!body.is_empty(), "Should have at least one provider");
    // Check mock-digid exists (ProviderInfoExtended flattens ProviderInfo, so "id" is at top level)
    assert!(
        body.iter().any(|p| p["id"] == "mock-digid"),
        "Should have mock-digid provider: {:?}",
        body
    );
}

#[tokio::test]
#[ignore]
async fn test_list_oidc_providers() {
    let server = TestServer::new().await;
    let resp = server.get("/auth/providers").await;
    assert_eq!(resp.status(), 200);
    // May be empty if no OIDC providers configured, but should return 200
    let body: Vec<Value> = resp.json().await.unwrap();
    // Just verify it's a valid array
    let _ = body.len();
}

// ==========================================================================
// Session Management
// ==========================================================================

#[tokio::test]
#[ignore]
async fn test_create_session_mock_digid() {
    let server = TestServer::new().await;
    let resp = server
        .post("/sessions", &json!({"providerId": "mock-digid"}))
        .await;
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().await.unwrap();
    assert!(body["sessionId"].is_string(), "Should return session ID");
    assert_eq!(body["providerId"], "mock-digid");
    assert!(body["status"].is_string(), "Should have status");
}

#[tokio::test]
#[ignore]
async fn test_create_session_mock_bankid() {
    let server = TestServer::new().await;
    let resp = server
        .post("/sessions", &json!({"providerId": "mock-bankid"}))
        .await;
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().await.unwrap();
    assert!(body["sessionId"].is_string());
    assert_eq!(body["providerId"], "mock-bankid");
}

#[tokio::test]
#[ignore]
async fn test_create_session_unknown_provider_fails() {
    let server = TestServer::new().await;
    let resp = server
        .post(
            "/sessions",
            &json!({"providerId": "nonexistent-provider"}),
        )
        .await;
    assert!(
        resp.status() == 404 || resp.status() == 400,
        "Unknown provider should fail with 404 or 400, got {}",
        resp.status()
    );
}

#[tokio::test]
#[ignore]
async fn test_get_session() {
    let server = TestServer::new().await;
    // Create session first
    let create_resp = server
        .post("/sessions", &json!({"providerId": "mock-digid"}))
        .await;
    let create_body: Value = create_resp.json().await.unwrap();
    let session_id = create_body["sessionId"].as_str().unwrap();

    // Get session
    let resp = server.get(&format!("/sessions/{}", session_id)).await;
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["id"], session_id);
    assert_eq!(body["providerId"], "mock-digid");
}

#[tokio::test]
#[ignore]
async fn test_get_nonexistent_session_returns_404() {
    let server = TestServer::new().await;
    let fake_id = uuid::Uuid::new_v4();
    let resp = server.get(&format!("/sessions/{}", fake_id)).await;
    assert_eq!(resp.status(), 404, "Non-existent session should return 404");
}

// ==========================================================================
// Full Flow: Create Session -> Auto-Verify -> Get Claims -> Issue Credential
// ==========================================================================

#[tokio::test]
#[ignore]
async fn test_full_issuance_flow_mock_digid() {
    let server = TestServer::new().await;

    // 1. Create session
    let create_resp = server
        .post("/sessions", &json!({"providerId": "mock-digid"}))
        .await;
    assert_eq!(create_resp.status(), 200);
    let session: Value = create_resp.json().await.unwrap();
    let session_id = session["sessionId"].as_str().unwrap();

    // 2. Auto-verify (simulates provider verification with sample data)
    let verify_resp = server
        .post(
            &format!("/sessions/{}/auto-verify", session_id),
            &json!({}),
        )
        .await;
    assert_eq!(verify_resp.status(), 200, "Auto-verify should succeed");
    let claims: Value = verify_resp.json().await.unwrap();
    assert_eq!(claims["firstName"], "Jan", "DigiD mock should return Jan");
    assert_eq!(claims["nationality"], "Dutch");
    assert_eq!(claims["isOver18"], true);
    assert_eq!(claims["isEuCitizen"], true);

    // 3. Get claims
    let claims_resp = server
        .get(&format!("/sessions/{}/claims", session_id))
        .await;
    assert_eq!(claims_resp.status(), 200);
    let stored_claims: Value = claims_resp.json().await.unwrap();
    assert_eq!(stored_claims["firstName"], "Jan");

    // 4. Issue credential with Ed25519 owner key
    let owner = owl_crypto::KeyPair::generate();
    let issue_resp = server
        .post(
            &format!("/sessions/{}/issue", session_id),
            &json!({
                "ownerPublicKey": owner.public_key().to_hex(),
                "keyAlgorithm": "ed25519"
            }),
        )
        .await;
    assert_eq!(
        issue_resp.status(),
        200,
        "Credential issuance should succeed"
    );
    let issue_body: Value = issue_resp.json().await.unwrap();
    assert_eq!(issue_body["success"], true);
    assert!(
        issue_body["credential"].is_object(),
        "Should return credential object"
    );
    assert!(
        issue_body["credential"]["root_hash"].is_string()
            || issue_body["credential"]["rootHash"].is_string(),
        "Credential should have root_hash"
    );
}

#[tokio::test]
#[ignore]
async fn test_full_issuance_flow_mock_bankid() {
    let server = TestServer::new().await;

    // 1. Create session
    let create_resp = server
        .post("/sessions", &json!({"providerId": "mock-bankid"}))
        .await;
    let session: Value = create_resp.json().await.unwrap();
    let session_id = session["sessionId"].as_str().unwrap();

    // 2. Auto-verify
    let verify_resp = server
        .post(
            &format!("/sessions/{}/auto-verify", session_id),
            &json!({}),
        )
        .await;
    assert_eq!(verify_resp.status(), 200);
    let claims: Value = verify_resp.json().await.unwrap();
    assert_eq!(claims["firstName"], "Erik", "BankID mock should return Erik");
    assert_eq!(claims["nationality"], "Swedish");

    // 3. Issue credential
    let owner = owl_crypto::KeyPair::generate();
    let issue_resp = server
        .post(
            &format!("/sessions/{}/issue", session_id),
            &json!({
                "ownerPublicKey": owner.public_key().to_hex(),
                "keyAlgorithm": "ed25519"
            }),
        )
        .await;
    assert_eq!(issue_resp.status(), 200);
    let body: Value = issue_resp.json().await.unwrap();
    assert_eq!(body["success"], true);
}

// ==========================================================================
// Error Cases
// ==========================================================================

#[tokio::test]
#[ignore]
async fn test_issue_before_verify_fails() {
    let server = TestServer::new().await;

    // Create session but DON'T verify
    let create_resp = server
        .post("/sessions", &json!({"providerId": "mock-digid"}))
        .await;
    let session: Value = create_resp.json().await.unwrap();
    let session_id = session["sessionId"].as_str().unwrap();

    // Try to issue without verification
    let owner = owl_crypto::KeyPair::generate();
    let resp = server
        .post(
            &format!("/sessions/{}/issue", session_id),
            &json!({
                "ownerPublicKey": owner.public_key().to_hex(),
                "keyAlgorithm": "ed25519"
            }),
        )
        .await;
    assert_eq!(
        resp.status(),
        400,
        "Issuing before verification should fail"
    );
}

#[tokio::test]
#[ignore]
async fn test_get_claims_before_verify_fails() {
    let server = TestServer::new().await;

    let create_resp = server
        .post("/sessions", &json!({"providerId": "mock-digid"}))
        .await;
    let session: Value = create_resp.json().await.unwrap();
    let session_id = session["sessionId"].as_str().unwrap();

    let resp = server
        .get(&format!("/sessions/{}/claims", session_id))
        .await;
    assert_eq!(
        resp.status(),
        400,
        "Getting claims before verification should fail"
    );
}

// ==========================================================================
// Cross-Service E2E: Issue on Issuer -> Verify on Verification Service
// ==========================================================================

#[tokio::test]
#[ignore]
async fn test_cross_service_issue_then_verify() {
    let issuer_url = std::env::var("ISSUER_SERVICE_URL")
        .unwrap_or_else(|_| "http://localhost:8001".to_string());
    let verify_url = std::env::var("VERIFICATION_SERVICE_URL")
        .unwrap_or_else(|_| "http://localhost:8000".to_string());
    let client = Client::new();
    let api_key = "dev_key_12345678901234567890123456789012";

    // Check both services
    let h1 = client
        .get(format!("{}/health", issuer_url))
        .send()
        .await;
    let h2 = client
        .get(format!("{}/health", verify_url))
        .send()
        .await;
    if h1.is_err() || h2.is_err() {
        eprintln!("Skipping cross-service test: both services must be running");
        return;
    }

    // 1. Get issuer info (public key)
    let info: Value = client
        .get(format!("{}/issuer-info", issuer_url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let issuer_pk = info["publicKey"].as_str().unwrap();

    // 2. Register issuer on verification service
    client
        .post(format!("{}/trusted-issuers", verify_url))
        .header("X-API-Key", api_key)
        .json(&json!({"public_key": issuer_pk, "name": "Cross-Service Test Issuer"}))
        .send()
        .await
        .unwrap();

    // 3. Issue credential via issuer service
    let session: Value = client
        .post(format!("{}/sessions", issuer_url))
        .json(&json!({"providerId": "mock-digid"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let sid = session["sessionId"].as_str().unwrap();

    client
        .post(format!(
            "{}/sessions/{}/auto-verify",
            issuer_url, sid
        ))
        .json(&json!({}))
        .send()
        .await
        .unwrap();

    let owner = owl_crypto::KeyPair::generate();
    let issue_body: Value = client
        .post(format!("{}/sessions/{}/issue", issuer_url, sid))
        .json(&json!({"ownerPublicKey": owner.public_key().to_hex(), "keyAlgorithm": "ed25519"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert_eq!(issue_body["success"], true, "Issuance should succeed");

    // 4. Build token from issued credential
    let credential = &issue_body["credential"];
    let proof_doc_json = serde_json::to_string(credential).unwrap();
    let mut proof_doc: owl_proof_system::ProofDocument =
        serde_json::from_str(&proof_doc_json).unwrap();

    let challenge = format!("cross_svc_{}", uuid::Uuid::new_v4());
    let request = owl_proof_system::ProofRequest {
        disclose: vec!["firstName".to_string()],
        predicates: vec![],
        trusted_issuers: vec![issuer_pk.to_string()],
        challenge: challenge.clone(),
    };

    let token =
        owl_proof_system::Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();
    let compact = token.to_compact().unwrap();

    // 5. Verify on verification service
    let verify_resp: Value = client
        .post(format!("{}/verify", verify_url))
        .header("X-API-Key", api_key)
        .json(&json!({"token": compact, "challenge": challenge}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert_eq!(
        verify_resp["valid"], true,
        "Cross-service verification should pass: {:?}",
        verify_resp
    );
    assert_eq!(
        verify_resp["subjects"]["firstName"], "Jan",
        "Should disclose Jan from DigiD mock"
    );
}

// ==========================================================================
// T-017: OIDC login endpoint
// ==========================================================================

#[tokio::test]
#[ignore]
async fn test_t017_oidc_login_unknown_provider() {
    let server = TestServer::new().await;
    let resp = server.get("/auth/login/nonexistent").await;
    // Should return 404 since provider doesn't exist
    assert!(
        resp.status() == 404 || resp.status() == 400,
        "T-017: Unknown OIDC provider should return 404/400, got {}",
        resp.status()
    );
}
