# Admin Backlog

Living tracking doc for admin-surface work that is **not yet shipped**.
Each item is scoped to fit in one focused PR; risk + estimate are rough
calls intended to help sequence the work, not promises.

For what _is_ shipped, see the most recent commits on `main`.

---

## Recently shipped (context)

- **Cookie + JWT admin auth across services** — verification-service mints
  the JWT; issuer-service validates the same cookie via `ADMIN_JWT_SECRET`.
  Cookie carries explicit `permissions` (currently `[admin, gdpr, verify]`
  for the built-in admin) and is scoped via `Domain=localhost` (dev) or
  `ADMIN_COOKIE_DOMAIN` (prod) so it reaches both services.
- **AuthMiddleware fallback** — verification-service tolerates a
  stale/missing `Authorization: Bearer` and falls through to the cookie.
- **Midnight runtime toggle** — `system_settings.midnight_enabled`,
  `POST /admin/midnight/{enable,disable}`, `GET /admin/midnight/status`,
  status card on the dashboard, switch in Settings.
- **Identity-provider runtime toggle** — `provider_settings`,
  `POST /admin/providers/{id}/{enable,disable}`, switch on Providers
  page. Disabled providers reject session creation closed.
- **Typed metrics + revoked-credentials** — replaced `serde_json::Value`
  bodies with `MetricsResponse` / `RevocationEntry`, regenerated TS
  clients. Dropped raw-fetch workarounds in the SPA.
- **Unified `ServiceStatusCard`** — used for verification, issuer, and
  Midnight; renders URL + state badge + observed health latency.

---

## P0 — gaps that block operator self-service

### 1. OIDC provider enable/disable

**Why.** Operators today can flip the IDP provider list on/off
(`/admin/providers/{id}/{enable,disable}`) but the OIDC providers under
`/auth/providers` are still env-only. A compromised or misconfigured OIDC
client cannot be retracted without a deploy.

**Scope.**

- Reuse the `provider_settings` table: keys are arbitrary IDs, so OIDC
  provider IDs slot in beside identity providers.
- Add `enabled: bool` to `OidcProviderInfo`. Filter the list emitted by
  `GET /auth/providers` to the enabled set, OR include the flag and let
  the SPA render disabled rows greyed out (preferred — matches the IDP
  side).
- New endpoints `POST /admin/oidc-providers/{id}/{enable,disable}`,
  same `admin` permission gate.
- Holder/admin app: a Switch column in the OIDC tab on the Providers
  page (mirror of the IDP tab).
- Server-side guard: `oidc_login` rejects with 400 when the provider
  id resolves to a disabled row.

**Risk.** Low — same pattern as the IDP toggle.
**Estimate.** ~half day.

### 2. Issuer-side GDPR counterpart

**Why.** `verification-service` exposes `DELETE /admin/gdpr-erasure/
{ownerPublicKey}` to wipe verification logs + revocation entries. The
issuer-service still has session/claims rows for that owner. A GDPR
erasure that scrubs only one half of the system is not compliant.

**Scope.**

- New `DELETE /admin/gdpr-erasure/{ownerPublicKey}` on issuer-service,
  gated by the same admin JWT path. Returns a typed
  `IssuerErasureReceipt { sessionsDeleted, claimsDeleted, credentialsDeleted }`.
- The erasure **must** cascade across `idp_sessions`, `claims`,
  `issued_credentials`, and any audit rows that store the public key.
- Admin SPA's existing GDPR UI calls both endpoints in sequence and
  presents a combined receipt.

**Risk.** Medium — the cascade list has to be exhaustive. Add an
integration test that reads each table after the call and asserts no
rows match the owner.
**Estimate.** ~day.

### 3. Issuer signing-key rotation

**Why.** `ISSUER_PRIVATE_KEY` is set once at boot. Rotating it today
means stopping the service, generating a new key, and restarting — and
nothing on the verification side proactively signals existing
credentials are still trusted. There is no operator-driven workflow.

**Scope.**

- `POST /admin/issuer-key/rotate` on issuer-service:
  - generates a fresh keypair,
  - inserts the new public key into the verification-service's
    `trusted_issuers` table (via the existing `add_trusted_issuer`
    handler — service-to-service authenticated by an issuer-side admin
    API key),
  - flips the issuer-service's in-memory key to the new private key.
- Old public key is **kept** as trusted for a configurable grace period
  (default 24h) so credentials in flight still verify.
- Admin SPA shows the active public key + a "Rotate now" button with a
  confirm dialog; previous keys appear under a "Recent keys" expander
  with the date they were retired.

**Risk.** High. Mistakes here invalidate every outstanding credential.
Before merging, write a test that exercises issue → rotate → verify the
old credential and a new one within the grace window.
**Estimate.** 2 days.

### 4. Issuer-side credential revocation

**Why.** Today, revocation lives only in verification-service. An
operator who wants to recall a single credential after issuance has to
manually post to `verification-service:/revocations/revoke` with the
credential's root hash — there is no UI flow that joins the issued
record to the revocation call.

**Scope.**

- New `POST /admin/credentials/{rootHash}/revoke` on issuer-service that:
  1. confirms the credential row exists in `issued_credentials`,
  2. proxies the revoke to verification-service using a service-to-service
     admin token (or the operator's JWT, forwarded),
  3. writes the revocation reason + operator id to an `issuer_revocations`
     table for audit symmetry with the existing verification side.
- Admin SPA: a Revoke action on each credential row in a credentials
  table (table itself is a separate small task — see #6 below).

**Risk.** Medium. Cross-service write needs idempotency: if the second
call fails after the first succeeds, the system is half-revoked. Wrap
in a saga that reconciles on next read.
**Estimate.** day + half.

---

## P1 — make operators less reliant on env files

### 5. DB-backed identity provider config

**Why.** Mock + Didit + future providers are presently registered from
hard-coded env at boot. Adding or removing a provider needs a deploy.
With config in DB, an operator can register a new (e.g. additional
mock-IDP for staging) without redeploying the issuer.

**Scope.**

- New `provider_configs` table: `id`, `kind` (mock-bankid/mock-digid/
  didit/oidc), `name`, `country`, `verification_levels` (jsonb),
  `secrets` (jsonb encrypted with the issuer's data key), audit cols.
- Boot loads configs from DB and instantiates one trait impl per row.
  Env still works as a default-seeder for first-boot.
- `POST /admin/providers` (create), `PUT /admin/providers/{id}`,
  `DELETE /admin/providers/{id}` endpoints.
- Admin SPA: a "Add provider" wizard.

**Risk.** Medium — secret encryption needs care. Use the `encryption_key`
already declared in verification-service config (or move the routine to
a small shared helper crate so issuer reuses it).
**Estimate.** 2 days.

### 6. OIDC client-secret reveal/rotate

**Why.** OIDC client secrets are static env values. Rotating one means
deploying. There's no admin surface to inspect or rotate them.

**Scope.**

- `GET /admin/oidc-providers/{id}/secret` — returns the secret **only
  once per call**, and only to the operator who initiated the request
  (audit row). Surfaced behind a "Reveal" button + a 30s clipboard copy.
- `POST /admin/oidc-providers/{id}/rotate-secret` — generates a new
  secret, persists it (encrypted), returns the raw value once. The old
  secret is invalidated immediately.
- Audit table for every reveal and rotate.

**Risk.** Medium. Reveal is sensitive — logs must NOT capture the
secret value, only the audit metadata. Add a trace-level filter.
**Estimate.** day.

### 7. Credentials browser

**Why.** Operators have no view of which credentials the issuer has
emitted. Used for support requests and as the entry point to #4.

**Scope.**

- New `GET /admin/credentials?owner=&issuedAfter=&issuedBefore=` with
  paging.
- Admin SPA: Credentials route with a filterable table; per-row actions
  to view metadata and (when #4 lands) revoke.

**Risk.** Low.
**Estimate.** half day.

---

## P2 — observability and audit

### 8. Audit log browser

**Why.** Both services already write to audit tables. Operators have to
SQL the DB to read them.

**Scope.**

- `GET /admin/audit?...` on both services with pagination + filtering
  by event type and entity id.
- Admin SPA: combined feed across the two services with badges to
  show which service emitted each row.

**Estimate.** half day.

### 9. Per-user permissions for admins

**Why.** Built-in admin gets `[admin, gdpr, verify]` hardcoded. A
support engineer who only needs to revoke shouldn't have full admin.

**Scope.**

- Add `admin_users.permissions: TEXT[]`. `login()` reads this column
  and bakes it into the JWT.
- Migration that backfills existing rows with the legacy default.
- Admin SPA: simple permission picker on the (not-yet-existing)
  user-management screen.

**Risk.** Low.
**Estimate.** half day for backend; admin user CRUD is a separate
~day's worth.

---

## Cross-cutting (do alongside any of the above)

- **CSRF token on state-changing /admin/\* calls.** Cookie auth +
  `SameSite=Strict` already mitigates most CSRF, but a header-bound
  CSRF token is the standard belt-and-braces. Lands as a single
  middleware once we have any non-trivial mutation.
- **Rate limit admin endpoints.** Login and rotate-secret in
  particular. The existing rate-limit middleware works per-API-key —
  needs to be extended to also key on the admin session for cookie
  callers.
- **Service-to-service admin token.** Items 3 + 4 require the
  issuer-service to call back into the verification-service as the
  operator. Either propagate the JWT (simplest, short-lived) or mint
  a dedicated service token. Decide before #3 lands.
