//! Live cross-service standards E2E for the OwlID stack.
//!
//! Exercises the real HTTP standard path end to end against running
//! services — no in-process shortcuts:
//!
//!   OpenID4VCI  discover -> /token -> /credential   (issuer :8001)
//!   holder      SD-JWT VC select-disclose + EdDSA KB-JWT
//!   OpenID4VP   /openid4vp/response direct_post      (verification :8000)
//!   did:web     issuer /.well-known/did.json resolves the `iss` key
//!   Status List issuer GET /status/1 (statuslist+jwt) verifies + idx live
//!
//! Replaces the deleted legacy (Token/Document/Merkle) e2e suite.
//!
//! Prerequisites: issuer-service on :8001 and verification-service on
//! :8000 (each with its Postgres + the Midnight sidecar), the issuer
//! key registered as a trusted issuer (auto-registered at issuer
//! startup). Run with:
//!
//!   cargo test -p owl-verification-service --test e2e_api -- --ignored --test-threads=1

use owl_crypto::{KeyPair, PublicKey};
use owl_proof_system::sd_jwt::{self, KbParams, SdJwtVc};
use owl_proof_system::status_list;
use reqwest::Client;
use serde_json::{Value, json};

fn issuer_url() -> String {
    std::env::var("ISSUER_SERVICE_URL").unwrap_or_else(|_| "http://localhost:8001".to_string())
}

fn verify_url() -> String {
    std::env::var("VERIFICATION_SERVICE_URL").unwrap_or_else(|_| "http://localhost:8000".to_string())
}

fn api_key() -> String {
    std::env::var("API_KEY_DEV")
        .unwrap_or_else(|_| "dev_key_12345678901234567890123456789012".to_string())
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// base64url (no pad) decode — for the DID-doc JWK `x` and JWT payloads.
fn b64url(s: &str) -> Vec<u8> {
    use base64::prelude::*;
    BASE64_URL_SAFE_NO_PAD
        .decode(s.trim_end_matches('='))
        .expect("base64url")
}

/// Issuer pubkey hex via the issuer's own `/issuer-info`.
async fn issuer_pubkey_hex(http: &Client) -> String {
    let info: Value = http
        .get(format!("{}/issuer-info", issuer_url()))
        .send()
        .await
        .expect("issuer reachable")
        .json()
        .await
        .expect("issuer-info json");
    info["publicKey"].as_str().expect("publicKey").to_string()
}

/// OpenID4VCI: session -> auto-verify -> /token -> /credential.
/// Returns the issued SD-JWT VC (issuance form `JWT~D1~..~Dn~`).
async fn issue_sd_jwt_vc(http: &Client, holder: &KeyPair) -> String {
    let created: Value = http
        .post(format!("{}/sessions", issuer_url()))
        .json(&json!({ "providerId": "mock-digid" }))
        .send()
        .await
        .expect("create session")
        .json()
        .await
        .expect("session json");
    let sid = created["sessionId"].as_str().expect("sessionId");
    let session_token = created["sessionToken"].as_str().expect("sessionToken");

    let claims: Value = http
        .post(format!("{}/sessions/{sid}/auto-verify", issuer_url()))
        .bearer_auth(session_token)
        .json(&json!({}))
        .send()
        .await
        .expect("auto-verify")
        .json()
        .await
        .expect("claims json");
    assert_eq!(claims["firstName"], "Jan", "mock-digid identity");
    assert_eq!(claims["isOver18"], true);

    // OpenID4VCI token endpoint — pre-authorized code grant.
    let token: Value = http
        .post(format!("{}/token", issuer_url()))
        .json(&json!({ "pre-authorized_code": sid }))
        .send()
        .await
        .expect("token")
        .json()
        .await
        .expect("token json");
    let access_token = token["access_token"].as_str().expect("access_token");
    assert_eq!(token["token_type"], "bearer");

    // OpenID4VCI credential endpoint — binds the holder cnf key.
    let cred: Value = http
        .post(format!("{}/credential", issuer_url()))
        .bearer_auth(access_token)
        .json(&json!({
            "ownerPublicKey": holder.public_key().to_hex(),
            "keyAlgorithm": "ed25519",
        }))
        .send()
        .await
        .expect("credential")
        .json()
        .await
        .expect("credential json");
    cred["credential"]
        .as_str()
        .expect("SD-JWT VC string")
        .to_string()
}

/// `status.status_list.idx` from the issuer JWT payload of an SD-JWT VC.
fn status_idx(sd_jwt_vc: &str) -> u64 {
    let jwt = sd_jwt_vc.split('~').next().expect("jwt segment");
    let payload = jwt.split('.').nth(1).expect("jwt payload");
    let v: Value = serde_json::from_slice(&b64url(payload)).expect("payload json");
    v["status"]["status_list"]["idx"]
        .as_u64()
        .expect("status.status_list.idx")
}

#[tokio::test]
#[ignore]
async fn oid4vci_metadata_and_did_web_resolve() {
    let http = Client::new();

    // OpenID4VCI Credential Issuer Metadata.
    let meta: Value = http
        .get(format!(
            "{}/.well-known/openid-credential-issuer",
            issuer_url()
        ))
        .send()
        .await
        .expect("issuer reachable")
        .json()
        .await
        .expect("metadata json");
    assert_eq!(
        meta["credential_configurations_supported"]["owlid_identity"]["format"],
        "dc+sd-jwt"
    );
    assert!(
        meta["credential_endpoint"].as_str().unwrap().ends_with("/credential"),
        "advertises the credential endpoint"
    );
    assert!(meta["token_endpoint"].as_str().unwrap().ends_with("/token"));

    // did:web document — the `iss` key the verifier resolves.
    let doc: Value = http
        .get(format!("{}/.well-known/did.json", issuer_url()))
        .send()
        .await
        .expect("did.json")
        .json()
        .await
        .expect("did.json");
    let jwk = &doc["verificationMethod"][0]["publicKeyJwk"];
    assert_eq!(jwk["kty"], "OKP");
    assert_eq!(jwk["crv"], "Ed25519");

    // The DID-doc key MUST equal the issuer's signing key.
    let did_key_hex = hex::encode(b64url(jwk["x"].as_str().expect("jwk x")));
    assert_eq!(
        did_key_hex,
        issuer_pubkey_hex(&http).await,
        "did:web key == issuer signing key"
    );
}

#[tokio::test]
#[ignore]
async fn standard_oid4vc_cross_service_e2e() {
    let http = Client::new();

    // Holder cnf key (wallet-held Ed25519).
    let holder = KeyPair::generate();

    // --- OpenID4VCI: issue an SD-JWT VC ---
    let sd_jwt_vc = issue_sd_jwt_vc(&http, &holder).await;
    assert!(
        sd_jwt_vc.contains('~'),
        "SD-JWT VC issuance form, got: {}",
        &sd_jwt_vc[..sd_jwt_vc.len().min(40)]
    );
    assert_eq!(
        sd_jwt::peek_iss(&sd_jwt_vc).expect("peek iss"),
        "did:web:localhost%3A8001",
        "iss is the issuer did:web identifier"
    );

    // --- Verifier nonce (one-shot, server-generated) ---
    let challenge: String = {
        let c: Value = http
            .get(format!("{}/verify/challenge", verify_url()))
            .bearer_auth(api_key())
            .send()
            .await
            .expect("challenge")
            .json()
            .await
            .expect("challenge json");
        c["challenge"].as_str().expect("challenge").to_string()
    };

    // --- Holder: selective disclosure + EdDSA KB-JWT bound to the nonce ---
    let (vc, _kb) = SdJwtVc::parse(&sd_jwt_vc).expect("parse SD-JWT VC");
    let audience = "https://verifier.owlid.example".to_string();
    let presentation = vc
        .present(
            &["given_name", "age_over_18"],
            Some(KbParams {
                holder: &holder,
                aud: audience.clone(),
                nonce: challenge.clone(),
                iat: now(),
            }),
        )
        .expect("present");

    // --- OpenID4VP: direct_post ---
    let vr: Value = http
        .post(format!("{}/openid4vp/response", verify_url()))
        .bearer_auth(api_key())
        .json(&json!({ "vp_token": {"cred0": presentation}, "state": challenge }))
        .send()
        .await
        .expect("openid4vp/response")
        .json()
        .await
        .expect("verify json");
    assert_eq!(vr["valid"], true, "verification failed: {vr}");
    assert_eq!(
        vr["subjects"]["cred0"]["given_name"], "Jan",
        "disclosed given_name"
    );
    assert_eq!(
        vr["subjects"]["cred0"]["age_over_18"], true,
        "disclosed age_over_18 (Midnight predicate projection)"
    );
    assert!(
        vr["subjects"]["cred0"].get("family_name").is_none(),
        "undisclosed claim must NOT leak"
    );

    // --- Stale/reused challenge is rejected (one-shot nonce) ---
    let replay: Value = http
        .post(format!("{}/openid4vp/response", verify_url()))
        .bearer_auth(api_key())
        .json(&json!({ "vp_token": {"cred0": presentation}, "state": challenge }))
        .send()
        .await
        .expect("replay")
        .json()
        .await
        .expect("replay json");
    assert_eq!(replay["valid"], false, "replayed nonce must be rejected");

    // --- IETF Token Status List: signed, issuer-verifiable, idx live ---
    let resp = http
        .get(format!("{}/status/1", issuer_url()))
        .send()
        .await
        .expect("status list");
    assert_eq!(
        resp.headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        Some("application/statuslist+jwt")
    );
    let jwt = resp.text().await.expect("status jwt");
    let issuer_pk = PublicKey::from_hex(&issuer_pubkey_hex(&http).await).expect("issuer pk");
    let list = status_list::verify_status_list_jwt(&jwt, &issuer_pk)
        .expect("status list jwt verifies under the issuer key");
    assert!(
        !list.is_revoked(status_idx(&sd_jwt_vc)),
        "a freshly issued credential is not revoked in the status list"
    );
}

#[tokio::test]
#[ignore]
async fn revoked_credential_is_rejected_and_status_list_reflects_it() {
    let http = Client::new();
    let holder = KeyPair::generate();

    let sd_jwt_vc = issue_sd_jwt_vc(&http, &holder).await;
    let cred_id = sd_jwt::credential_id(&sd_jwt_vc);
    let idx = status_idx(&sd_jwt_vc);
    let issuer_pk_hex = issuer_pubkey_hex(&http).await;

    // Revoke it (admin) — Midnight revocation_registry + the mirrored
    // verifier cache; the issuer projects it into the Status List.
    let rv = http
        .post(format!("{}/revocations/revoke", verify_url()))
        .bearer_auth(api_key())
        .json(&json!({
            "credentialId": cred_id,
            "issuerPublicKey": issuer_pk_hex,
            "reason": "e2e revocation test",
        }))
        .send()
        .await
        .expect("revoke");
    assert!(rv.status().is_success(), "revoke failed: {}", rv.status());

    // Present the revoked credential — verification must refuse it.
    let challenge: String = {
        let c: Value = http
            .get(format!("{}/verify/challenge", verify_url()))
            .bearer_auth(api_key())
            .send()
            .await
            .expect("challenge")
            .json()
            .await
            .expect("challenge json");
        c["challenge"].as_str().unwrap().to_string()
    };
    let (vc, _kb) = SdJwtVc::parse(&sd_jwt_vc).expect("parse");
    let presentation = vc
        .present(
            &["given_name"],
            Some(KbParams {
                holder: &holder,
                aud: "https://verifier.owlid.example".to_string(),
                nonce: challenge.clone(),
                iat: now(),
            }),
        )
        .expect("present");
    let vr: Value = http
        .post(format!("{}/openid4vp/response", verify_url()))
        .bearer_auth(api_key())
        .json(&json!({ "vp_token": {"cred0": presentation}, "state": challenge }))
        .send()
        .await
        .expect("openid4vp/response")
        .json()
        .await
        .expect("verify json");
    assert_eq!(vr["valid"], false, "a revoked credential must be rejected");

    // The IETF Token Status List the issuer publishes now marks this
    // credential's index revoked (same path a third-party verifier and
    // verify_token's status_list_revoked() consult).
    let jwt = http
        .get(format!("{}/status/1", issuer_url()))
        .send()
        .await
        .expect("status list")
        .text()
        .await
        .expect("status jwt");
    let issuer_pk = PublicKey::from_hex(&issuer_pk_hex).expect("issuer pk");
    let list = status_list::verify_status_list_jwt(&jwt, &issuer_pk).expect("status list verifies");
    assert!(
        list.is_revoked(idx),
        "revoked credential's idx must be set in the published status list"
    );

    // Midnight is the source of truth: the revocation must also land
    // on-chain (revocation_registry). The verification-service writes it
    // async via the sidecar; poll the sidecar's on-chain read (the same
    // path verify_token's midnight.is_credential_revoked() uses). The
    // on-chain handle is the 32-byte hex digest, not the base64url id.
    let cid_hex = sd_jwt::credential_id_hex(&cred_id).expect("cid hex");
    let sidecar = std::env::var("MIDNIGHT_SIDECAR_URL")
        .unwrap_or_else(|_| "http://localhost:3000".to_string());
    let mut on_chain = false;
    // ~3 min: a Midnight write tx (proof gen + submit + confirm + SSE
    // mirror) can exceed 90 s under cumulative-suite load on the local
    // devnet; the standards path itself is unaffected (the verifier
    // already rejected the presentation via cache + status list).
    for _ in 0..36 {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        let r: Value = http
            .get(format!("{sidecar}/api/revocations/{cid_hex}/revoked"))
            .bearer_auth(api_key())
            .send()
            .await
            .expect("sidecar revoked")
            .json()
            .await
            .expect("sidecar json");
        if r["revoked"].as_bool() == Some(true) {
            on_chain = true;
            break;
        }
        assert!(
            r.get("error").is_none(),
            "sidecar on-chain revocation errored (regression — base64url id \
             must be hex Bytes<32>): {r}"
        );
    }
    assert!(
        on_chain,
        "revocation must be anchored on-chain (Midnight revocation_registry)"
    );
}

#[tokio::test]
#[ignore]
async fn untrusted_issuer_presentation_is_rejected() {
    let http = Client::new();

    // An SD-JWT VC minted by a key that is NOT a Midnight trusted issuer,
    // with an `iss` that resolves nowhere — verification must refuse it.
    let rogue_issuer = KeyPair::generate();
    let holder = KeyPair::generate();
    let mut claims = std::collections::BTreeMap::new();
    claims.insert("given_name".to_string(), json!("Mallory"));
    let vc = SdJwtVc::issue(
        &claims,
        &sd_jwt::IssueParams {
            issuer: &rogue_issuer,
            iss: "did:web:attacker.invalid".to_string(),
            vct: "https://owlid.dev/credentials/identity".to_string(),
            holder: &holder.public_key(),
            iat: Some(now()),
            exp: None,
            status: None,
        },
    )
    .expect("rogue issue");

    let challenge: String = {
        let c: Value = http
            .get(format!("{}/verify/challenge", verify_url()))
            .bearer_auth(api_key())
            .send()
            .await
            .expect("challenge")
            .json()
            .await
            .expect("challenge json");
        c["challenge"].as_str().unwrap().to_string()
    };
    let presentation = vc
        .present(
            &["given_name"],
            Some(KbParams {
                holder: &holder,
                aud: "https://verifier.owlid.example".to_string(),
                nonce: challenge.clone(),
                iat: now(),
            }),
        )
        .expect("present");

    let vr: Value = http
        .post(format!("{}/openid4vp/response", verify_url()))
        .bearer_auth(api_key())
        .json(&json!({ "vp_token": {"cred0": presentation}, "state": challenge }))
        .send()
        .await
        .expect("openid4vp/response")
        .json()
        .await
        .expect("verify json");
    assert_eq!(
        vr["valid"], false,
        "an untrusted / unresolvable issuer must be rejected"
    );
}

// ---------------------------------------------------------------------------
// ES256 holder (standard P-256 / WebCrypto) — full live cross-service path.
// ---------------------------------------------------------------------------

fn b64url_enc(b: &[u8]) -> String {
    use base64::prelude::*;
    BASE64_URL_SAFE_NO_PAD.encode(b)
}

/// OID4VCI issue bound to a P-256 holder `cnf`, then present with a
/// standard ES256 KB-JWT (raw R‖S over `header.payload`) — exactly what
/// a non-extractable WebCrypto P-256 holder key produces. `present(.., None)`
/// emits the disclosure prefix without signing (the wallet EdDSA path),
/// so the ES256 KB-JWT is built here as a browser holder would.
#[tokio::test]
#[ignore]
async fn es256_p256_holder_oid4vp_e2e() {
    use owl_crypto::SignatureAlgorithm;
    use sha2::{Digest, Sha256};

    let http = Client::new();
    let holder = KeyPair::generate_with_algorithm(SignatureAlgorithm::EcdsaP256);

    // OID4VCI: session -> auto-verify -> /token -> /credential (p256 cnf).
    let created: Value = http
        .post(format!("{}/sessions", issuer_url()))
        .json(&json!({ "providerId": "mock-digid" }))
        .send()
        .await
        .expect("create session")
        .json()
        .await
        .expect("session json");
    let sid = created["sessionId"].as_str().unwrap();
    let stoken = created["sessionToken"].as_str().unwrap();
    http.post(format!("{}/sessions/{sid}/auto-verify", issuer_url()))
        .bearer_auth(stoken)
        .json(&json!({}))
        .send()
        .await
        .expect("auto-verify");
    let tok: Value = http
        .post(format!("{}/token", issuer_url()))
        .json(&json!({ "pre-authorized_code": sid }))
        .send()
        .await
        .expect("token")
        .json()
        .await
        .expect("token json");
    let cred: Value = http
        .post(format!("{}/credential", issuer_url()))
        .bearer_auth(tok["access_token"].as_str().unwrap())
        .json(&json!({
            "ownerPublicKey": holder.public_key().to_hex(),
            "keyAlgorithm": "p256",
        }))
        .send()
        .await
        .expect("credential")
        .json()
        .await
        .expect("credential json");
    let sd_jwt_vc = cred["credential"].as_str().expect("SD-JWT VC");

    // Verifier nonce.
    let challenge: String = {
        let c: Value = http
            .get(format!("{}/verify/challenge", verify_url()))
            .bearer_auth(api_key())
            .send()
            .await
            .expect("challenge")
            .json()
            .await
            .expect("challenge json");
        c["challenge"].as_str().unwrap().to_string()
    };

    // Holder: disclosure prefix (unsigned) + ES256 KB-JWT.
    let (vc, _kb) = SdJwtVc::parse(sd_jwt_vc).expect("parse");
    let prefix = vc.present(&["given_name"], None).expect("present prefix");
    let aud = "https://verifier.owlid.example";
    let sd_hash = b64url_enc(&Sha256::digest(prefix.as_bytes()));
    let h = b64url_enc(&serde_json::to_vec(&json!({ "typ": "kb+jwt", "alg": "ES256" })).unwrap());
    let p = b64url_enc(
        &serde_json::to_vec(
            &json!({ "iat": 1, "aud": aud, "nonce": challenge, "sd_hash": sd_hash }),
        )
        .unwrap(),
    );
    let signing_input = format!("{h}.{p}");
    let sig = holder.sign(signing_input.as_bytes());
    let presentation = format!("{prefix}{signing_input}.{}", b64url_enc(sig.bytes()));

    // OID4VP direct_post — must verify under the ES256 holder key.
    let vr: Value = http
        .post(format!("{}/openid4vp/response", verify_url()))
        .bearer_auth(api_key())
        .json(&json!({ "vp_token": {"cred0": presentation}, "state": challenge }))
        .send()
        .await
        .expect("openid4vp/response")
        .json()
        .await
        .expect("verify json");
    assert_eq!(vr["valid"], true, "ES256 holder presentation failed: {vr}");
    assert_eq!(vr["subjects"]["cred0"]["given_name"], "Jan");
}

// ---------------------------------------------------------------------------
// Unlinkability via OpenID4VCI Batch Credential issuance.
// Two presentations of the "same identity" use distinct one-time-use
// credentials with distinct `credential_id`s, so a colluding pair of
// verifiers cannot correlate them. Each is independently revocable on
// Midnight (the revocation_registry is keyed by credential_id).
// ---------------------------------------------------------------------------

async fn present_with_kb(http: &Client, vc: &SdJwtVc, holder: &KeyPair) -> (String, String) {
    let challenge: String = {
        let c: Value = http
            .get(format!("{}/verify/challenge", verify_url()))
            .bearer_auth(api_key())
            .send()
            .await
            .expect("challenge")
            .json()
            .await
            .expect("challenge json");
        c["challenge"].as_str().unwrap().to_string()
    };
    let presentation = vc
        .present(
            &["given_name"],
            Some(KbParams {
                holder,
                aud: "https://verifier.owlid.example".to_string(),
                nonce: challenge.clone(),
                iat: now(),
            }),
        )
        .expect("present");
    (presentation, challenge)
}

async fn oid4vp_verify(http: &Client, presentation: &str, state_nonce: &str) -> Value {
    http.post(format!("{}/openid4vp/response", verify_url()))
        .bearer_auth(api_key())
        .json(&json!({ "vp_token": {"cred0": presentation}, "state": state_nonce }))
        .send()
        .await
        .expect("openid4vp/response")
        .json()
        .await
        .expect("verify json")
}

#[tokio::test]
#[ignore]
async fn oid4vci_batch_issuance_unlinkability_e2e() {
    let http = Client::new();
    let holder = KeyPair::generate();

    // Establish a verified issuance session, then exchange the
    // pre-authorized code for the OID4VCI access token.
    let created: Value = http
        .post(format!("{}/sessions", issuer_url()))
        .json(&json!({ "providerId": "mock-digid" }))
        .send()
        .await
        .expect("create session")
        .json()
        .await
        .expect("session json");
    let sid = created["sessionId"].as_str().unwrap();
    let stoken = created["sessionToken"].as_str().unwrap();
    http.post(format!("{}/sessions/{sid}/auto-verify", issuer_url()))
        .bearer_auth(stoken)
        .json(&json!({}))
        .send()
        .await
        .expect("auto-verify");
    let tok: Value = http
        .post(format!("{}/token", issuer_url()))
        .json(&json!({ "pre-authorized_code": sid }))
        .send()
        .await
        .expect("token")
        .json()
        .await
        .expect("token json");

    // OID4VCI Batch Credential Endpoint — request 3 one-time-use VCs.
    let cred: Value = http
        .post(format!("{}/credential", issuer_url()))
        .bearer_auth(tok["access_token"].as_str().unwrap())
        .json(&json!({
            "ownerPublicKey": holder.public_key().to_hex(),
            "keyAlgorithm": "ed25519",
            "batchSize": 3,
        }))
        .send()
        .await
        .expect("credential")
        .json()
        .await
        .expect("credential json");
    let batch = cred["credentials"]
        .as_array()
        .expect("batch credentials array");
    assert_eq!(batch.len(), 3, "batchSize honoured");

    // Each batch credential has a distinct credential_id and a distinct
    // statusIdx — Midnight anchors them independently.
    let ids: std::collections::HashSet<String> = batch
        .iter()
        .map(|v| sd_jwt::credential_id(v.as_str().unwrap()))
        .collect();
    assert_eq!(ids.len(), 3, "credential_ids must be distinct (unlinkable)");
    let idxs: std::collections::HashSet<u64> = batch
        .iter()
        .map(|v| status_idx(v.as_str().unwrap()))
        .collect();
    assert_eq!(idxs.len(), 3, "statusIdx must be distinct per credential");

    // Each credential presents standardly and discloses the same claim
    // (the holder uses each at most once — that is the unlinkability
    // contract; the verifier cannot tell two presentations share an
    // underlying identity from the SD-JWT VC alone).
    let mut presented: Vec<String> = Vec::new();
    for v in batch {
        let (vc, _kb) = SdJwtVc::parse(v.as_str().unwrap()).expect("parse");
        let (p, c) = present_with_kb(&http, &vc, &holder).await;
        let vr = oid4vp_verify(&http, &p, &c).await;
        assert_eq!(vr["valid"], true, "batch credential failed verify: {vr}");
        assert_eq!(vr["subjects"]["cred0"]["given_name"], "Jan");
        presented.push(sd_jwt::credential_id(v.as_str().unwrap()));
    }
    let unique: std::collections::HashSet<&String> = presented.iter().collect();
    assert_eq!(
        unique.len(),
        3,
        "two presentations cannot share a credential_id"
    );

    // Independent revocation: revoking one batch credential leaves the
    // others valid. Midnight's revocation_registry is keyed by
    // credential_id, so this is correct by construction.
    let issuer_pk_hex = issuer_pubkey_hex(&http).await;
    let revoke_id = sd_jwt::credential_id(batch[0].as_str().unwrap());
    let r = http
        .post(format!("{}/revocations/revoke", verify_url()))
        .bearer_auth(api_key())
        .json(&json!({
            "credentialId": revoke_id,
            "issuerPublicKey": issuer_pk_hex,
            "reason": "unlinkability-e2e",
        }))
        .send()
        .await
        .expect("revoke");
    assert!(r.status().is_success());

    // batch[0] now rejected.
    let (vc0, _) = SdJwtVc::parse(batch[0].as_str().unwrap()).expect("parse");
    let (p0, c0) = present_with_kb(&http, &vc0, &holder).await;
    let v0 = oid4vp_verify(&http, &p0, &c0).await;
    assert_eq!(v0["valid"], false, "revoked batch credential must reject");

    // batch[1] still valid — independent on-chain handle.
    let (vc1, _) = SdJwtVc::parse(batch[1].as_str().unwrap()).expect("parse");
    let (p1, c1) = present_with_kb(&http, &vc1, &holder).await;
    let v1 = oid4vp_verify(&http, &p1, &c1).await;
    assert_eq!(v1["valid"], true, "sibling batch credential must stay valid");
}

// ---------------------------------------------------------------------------
// OpenID4VP 1.0 §5 Authorization Request flow.
// External wallets bootstrap by scanning `openid4vp://?request_uri=…`,
// GETing the Request Object, building a vp_token, POSTing it back as
// form-encoded `application/x-www-form-urlencoded`. The same response
// endpoint that takes the OwlID JSON shape also accepts the standard
// form-encoded body.
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn openid4vp_authorization_request_flow_e2e() {
    let http = Client::new();
    let holder = KeyPair::generate();
    let sd_jwt_vc = issue_sd_jwt_vc(&http, &holder).await;

    // 1. Verifier creates a presentation session WITH a DCQL query.
    let create: Value = http
        .post(format!("{}/presentation/sessions", verify_url()))
        .json(&json!({
            "dcql": {
                "credentials": [
                    {
                        "id": "passport",
                        "format": "dc+sd-jwt",
                        "claims": [{ "path": ["given_name"] }]
                    }
                ]
            },
            "verifierName": "OwlID E2E Test",
            "audience": "https://verifier.owlid.example"
        }))
        .send()
        .await
        .expect("create session")
        .json()
        .await
        .expect("session json");
    let session_id = create["sessionId"].as_str().expect("sessionId");
    let nonce = create["nonce"].as_str().expect("nonce").to_string();
    let request_uri = create["requestUri"].as_str().expect("requestUri");
    let response_uri = create["responseUri"].as_str().expect("responseUri");
    let openid4vp_uri = create["openid4vpUri"].as_str().expect("openid4vpUri");
    assert!(
        openid4vp_uri.starts_with("openid4vp://?request_uri="),
        "deeplink shape (got {openid4vp_uri})"
    );
    assert!(
        request_uri.ends_with(&format!("/openid4vp/request/{session_id}")),
        "request_uri (got {request_uri})"
    );

    // 2. Wallet fetches the Request Object.
    let req_obj: Value = http
        .get(request_uri)
        .send()
        .await
        .expect("request_uri GET")
        .json()
        .await
        .expect("request object json");
    assert_eq!(req_obj["client_id_scheme"], "redirect_uri");
    assert_eq!(req_obj["response_type"], "vp_token");
    assert_eq!(req_obj["response_mode"], "direct_post");
    assert_eq!(req_obj["response_uri"], response_uri);
    assert_eq!(req_obj["nonce"], nonce);
    assert_eq!(req_obj["client_id"], response_uri);
    assert_eq!(req_obj["client_metadata"]["client_name"], "OwlID E2E Test");
    let vp_formats = &req_obj["client_metadata"]["vp_formats"];
    assert!(
        vp_formats.get("dc+sd-jwt").is_some(),
        "vp_formats lists dc+sd-jwt"
    );
    let dcql = &req_obj["dcql_query"];
    assert_eq!(dcql["credentials"][0]["id"], "passport");

    // 3. Wallet builds vp_token bound to the published nonce + aud.
    let (vc, _) = SdJwtVc::parse(&sd_jwt_vc).expect("parse");
    let presentation = vc
        .present(
            &["given_name"],
            Some(KbParams {
                holder: &holder,
                aud: "https://verifier.owlid.example".to_string(),
                nonce: nonce.clone(),
                iat: now(),
            }),
        )
        .expect("present");

    // 4. Wallet POSTs form-encoded body to /openid4vp/response
    //    (the standard OpenID4VP §8.2 wire format).
    let vp_token_json = serde_json::to_string(&json!({ "passport": presentation })).unwrap();
    let form_body = format!(
        "vp_token={}&state={}&presentation_submission={}",
        urlencoding(&vp_token_json),
        urlencoding(&nonce),
        urlencoding("{\"id\":\"submission-1\",\"definition_id\":\"...\",\"descriptor_map\":[]}")
    );
    let vr: Value = http
        .post(response_uri)
        .bearer_auth(api_key())
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form_body)
        .send()
        .await
        .expect("direct_post")
        .json()
        .await
        .expect("verify json");
    assert_eq!(
        vr["valid"], true,
        "form-encoded direct_post must verify: {vr}"
    );
    assert_eq!(vr["subjects"]["passport"]["given_name"], "Jan");
}

#[tokio::test]
#[ignore]
async fn openid4vp_request_uri_404_for_unknown_session() {
    let http = Client::new();
    let r = http
        .get(format!("{}/openid4vp/request/does-not-exist", verify_url()))
        .send()
        .await
        .expect("GET");
    assert_eq!(r.status(), 404);
}

fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => out.push(c),
            _ => {
                let mut buf = [0u8; 4];
                let bytes = c.encode_utf8(&mut buf).as_bytes();
                for b in bytes {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Multi-credential DCQL composition.
// Two credentials issued under DISTINCT holder keys are presented in one
// vp_token (OpenID4VP 1.0 §8.1). Each entry's KB-JWT signs the same
// audience + nonce with its OWN cnf key — the "contextual same-person"
// model. The verifier returns per-credential verdicts + subjects merged
// under DCQL ids.
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn dcql_multi_credential_composition_e2e() {
    let http = Client::new();

    // Two independent holder keys — different `cnf` per credential, so
    // the wire mirrors the multi-IdP wallet's per-credential key story.
    let holder_a = KeyPair::generate();
    let holder_b = KeyPair::generate();

    let sd_jwt_a = issue_sd_jwt_vc(&http, &holder_a).await;
    let sd_jwt_b = issue_sd_jwt_vc(&http, &holder_b).await;
    assert_ne!(
        sd_jwt::credential_id(&sd_jwt_a),
        sd_jwt::credential_id(&sd_jwt_b),
        "two issuances yield distinct credential_ids"
    );

    // Single one-shot nonce binds every KB-JWT in the bundle.
    let challenge: String = {
        let c: Value = http
            .get(format!("{}/verify/challenge", verify_url()))
            .bearer_auth(api_key())
            .send()
            .await
            .expect("challenge")
            .json()
            .await
            .expect("challenge json");
        c["challenge"].as_str().unwrap().to_string()
    };
    let aud = "https://verifier.owlid.example".to_string();

    let (vc_a, _) = SdJwtVc::parse(&sd_jwt_a).expect("parse a");
    let (vc_b, _) = SdJwtVc::parse(&sd_jwt_b).expect("parse b");

    let pres_a = vc_a
        .present(
            &["given_name"],
            Some(KbParams {
                holder: &holder_a,
                aud: aud.clone(),
                nonce: challenge.clone(),
                iat: now(),
            }),
        )
        .expect("present a");
    let pres_b = vc_b
        .present(
            &["age_over_18"],
            Some(KbParams {
                holder: &holder_b,
                aud: aud.clone(),
                nonce: challenge.clone(),
                iat: now(),
            }),
        )
        .expect("present b");

    // OID4VP direct_post with a multi-entry vp_token map.
    let vr: Value = http
        .post(format!("{}/openid4vp/response", verify_url()))
        .bearer_auth(api_key())
        .json(&json!({
            "vp_token": { "passport": pres_a, "age": pres_b },
            "state": challenge,
        }))
        .send()
        .await
        .expect("openid4vp/response")
        .json()
        .await
        .expect("verify json");

    assert_eq!(
        vr["valid"], true,
        "every credential in the vp_token must verify: {vr}"
    );
    assert_eq!(
        vr["perCredential"]["passport"]["valid"], true,
        "per-cred passport valid"
    );
    assert_eq!(
        vr["perCredential"]["age"]["valid"], true,
        "per-cred age valid"
    );
    assert_eq!(
        vr["subjects"]["passport"]["given_name"], "Jan",
        "merged subjects namespaced by DCQL id"
    );
    assert_eq!(
        vr["subjects"]["age"]["age_over_18"], true,
        "merged subjects namespaced by DCQL id"
    );
    assert!(
        vr["subjects"]["passport"].get("age_over_18").is_none(),
        "claim only disclosed in entry B must NOT leak into entry A"
    );

    // Replay of the SAME challenge with a new vp_token must fail —
    // the nonce was consumed exactly once when the multi-cred bundle
    // verified.
    let replay = vc_a
        .present(
            &["given_name"],
            Some(KbParams {
                holder: &holder_a,
                aud: aud.clone(),
                nonce: challenge.clone(),
                iat: now(),
            }),
        )
        .expect("present replay");
    let vr2: Value = http
        .post(format!("{}/openid4vp/response", verify_url()))
        .bearer_auth(api_key())
        .json(&json!({
            "vp_token": { "passport": replay },
            "state": challenge,
        }))
        .send()
        .await
        .expect("openid4vp/response replay")
        .json()
        .await
        .expect("verify json");
    assert_eq!(vr2["valid"], false, "replayed nonce must be rejected");
}

// ---------------------------------------------------------------------------
// DCQL claim-path + credential_sets enforcement.
// `/verify/dcql` should accept a query that constrains the disclosed
// claim values and run the credential_sets solver across responses.
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn dcql_credential_sets_solver_e2e() {
    let http = Client::new();
    let holder = KeyPair::generate();
    let sd_jwt_vc = issue_sd_jwt_vc(&http, &holder).await;

    let challenge: String = {
        let c: Value = http
            .get(format!("{}/verify/challenge", verify_url()))
            .bearer_auth(api_key())
            .send()
            .await
            .expect("challenge")
            .json()
            .await
            .expect("challenge json");
        c["challenge"].as_str().unwrap().to_string()
    };
    let aud = "https://verifier.owlid.example".to_string();

    let (vc, _) = SdJwtVc::parse(&sd_jwt_vc).expect("parse");
    let presentation = vc
        .present(
            &["given_name", "age_over_18"],
            Some(KbParams {
                holder: &holder,
                aud: aud.clone(),
                nonce: challenge.clone(),
                iat: now(),
            }),
        )
        .expect("present");

    // 1-entry vp_token + DCQL query that REQUIRES an age>=18 attestation.
    let vr: Value = http
        .post(format!("{}/verify/dcql", verify_url()))
        .bearer_auth(api_key())
        .json(&json!({
            "vpToken": { "passport": presentation },
            "challenge": challenge,
            "audience": aud,
            "query": {
                "credentials": [
                    {
                        "id": "passport",
                        "format": "dc+sd-jwt",
                        "claims": [
                            { "path": ["age_over"], "values": [18] }
                        ]
                    }
                ],
                "credential_sets": [
                    { "options": [["passport"]], "required": true }
                ]
            }
        }))
        .send()
        .await
        .expect("verify/dcql")
        .json()
        .await
        .expect("verify json");
    assert_eq!(vr["valid"], true, "DCQL with values match must accept: {vr}");
    assert_eq!(vr["perCredential"]["passport"]["valid"], true);

    // Mint a fresh nonce, present a NEW vp_token, run DCQL with an
    // age threshold the credential cannot satisfy.
    let challenge2: String = {
        let c: Value = http
            .get(format!("{}/verify/challenge", verify_url()))
            .bearer_auth(api_key())
            .send()
            .await
            .expect("challenge2")
            .json()
            .await
            .expect("challenge2 json");
        c["challenge"].as_str().unwrap().to_string()
    };
    let presentation2 = vc
        .present(
            &["given_name", "age_over_18"],
            Some(KbParams {
                holder: &holder,
                aud: aud.clone(),
                nonce: challenge2.clone(),
                iat: now(),
            }),
        )
        .expect("present2");
    let vr_fail: Value = http
        .post(format!("{}/verify/dcql", verify_url()))
        .bearer_auth(api_key())
        .json(&json!({
            "vpToken": { "passport": presentation2 },
            "challenge": challenge2,
            "audience": aud,
            "query": {
                "credentials": [
                    {
                        "id": "passport",
                        "format": "dc+sd-jwt",
                        "claims": [
                            { "path": ["age_over"], "values": [200] }
                        ]
                    }
                ]
            }
        }))
        .send()
        .await
        .expect("verify/dcql fail")
        .json()
        .await
        .expect("verify json");
    assert_eq!(
        vr_fail["valid"], false,
        "DCQL claim-value mismatch must reject the entry"
    );
}
