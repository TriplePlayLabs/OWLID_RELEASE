# HTTP API

Most integrations should use [`@owlid/sdk`](/quickstart) — it wraps these endpoints with typed clients, challenge handling, and the WebSocket presentation flow. Reach for the raw HTTP API only for non-TypeScript backends.

## Base URLs

| Service      | Base URL                   | OpenAPI explorer                       |
| ------------ | -------------------------- | -------------------------------------- |
| Verification | `https://api.owlid.app`    | `https://api.owlid.app/swagger-ui/`    |
| Issuer       | `https://issuer.owlid.app` | `https://issuer.owlid.app/swagger-ui/` |

The Swagger UI is the **canonical, always-current** reference — every route, request body, and response schema is generated from the live service. The tables below are a map of the surface.

All endpoints require an `Authorization: Bearer <api-key>` header unless marked otherwise.

## Verification service

| Method | Path                                     | Auth  | Description                          |
| ------ | ---------------------------------------- | ----- | ------------------------------------ |
| GET    | `/health`                                | none  | Health check                         |
| POST   | `/openid4vp/response`                    | none  | OpenID4VP `direct_post` endpoint     |
| POST   | `/verify/dcql`                           | key   | Verify a DCQL `vp_token` (OpenID4VP) |
| GET    | `/verify/challenge`                      | key   | Mint a single-use challenge nonce    |
| GET    | `/trusted-issuers`                       | key   | List trusted issuer entries          |
| GET    | `/predicates`                            | key   | List provable predicates             |
| GET    | `/circuit-data`                          | key   | List set-membership circuit datasets |
| POST   | `/revocations/check`                     | key   | Check if a credential is revoked     |
| GET    | `/revocations/list`                      | key   | List revoked credentials             |
| POST   | `/presentation/sessions`                 | key   | Open a QR/WS presentation session    |
| POST   | `/trusted-issuers`                       | admin | Register a trusted issuer            |
| POST   | `/revocations/revoke`                    | admin | Revoke a credential                  |
| POST   | `/revocations/suspend`                   | admin | Suspend a credential                 |
| POST   | `/revocations/reactivate`                | admin | Reactivate a credential              |
| DELETE | `/admin/gdpr-erasure/{owner_public_key}` | gdpr  | GDPR data erasure                    |

## Issuer service

| Method | Path                                    | Description                               |
| ------ | --------------------------------------- | ----------------------------------------- |
| GET    | `/.well-known/did.json`                 | did:web document (CORS-public)            |
| GET    | `/.well-known/openid-credential-issuer` | OpenID4VCI metadata                       |
| GET    | `/issuer-info`                          | Issuer public key + display name          |
| GET    | `/providers`                            | List identity verification providers      |
| POST   | `/sessions`                             | Start a verification session              |
| GET    | `/sessions/{id}`                        | Read session state                        |
| POST   | `/sessions/{id}/submit`                 | Submit identity data (form providers)     |
| GET    | `/sessions/{id}/claims`                 | Read verified claims for a session        |
| POST   | `/sessions/{id}/issue`                  | Issue SD-JWT VC(s) from verified claims   |
| POST   | `/sessions/{id}/complete`               | Complete async (webhook) verification     |
| GET    | `/polling/{session_id}`                 | Poll an async session until it terminates |
| POST   | `/token`                                | OpenID4VCI pre-authorized token           |
| POST   | `/credential`                           | OpenID4VCI single / Batch issuance        |
| GET    | `/status/{id}`                          | IETF Token Status List (`statuslist+jwt`) |

## Example — verify a presentation

The verify endpoint takes a DCQL `vp_token` (OpenID4VP 1.0). The SDK's `OwlVerifier.verify()` wraps this for you.

```bash
curl -X POST https://api.owlid.app/verify/dcql \
  -H "Authorization: Bearer $OWLID_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "vpToken": { "cred0": "<sd-jwt-vc>~<disclosure>~<disclosure>~<kb-jwt>" },
    "challenge": "the-nonce-used-in-kb-jwt",
    "query": { "credentials": [{ "id": "cred0", "format": "dc+sd-jwt", "claims": [] }] }
  }'
```

## Example — register a trusted issuer

```bash
KEY=$(curl -s https://issuer.owlid.app/issuer-info | jq -r '.publicKey')

curl -X POST https://api.owlid.app/trusted-issuers \
  -H "Authorization: Bearer $OWLID_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"publicKey\": \"$KEY\", \"name\": \"OwlID Issuer\"}"
```
