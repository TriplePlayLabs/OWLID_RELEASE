---
pageType: doc
---

<div class="owl-hero">
  <p class="owl-meta">DOCUMENTATION · V2.4</p>
  <h1 class="owl-h1">Privacy-first <span class="owl-gold">digital identity</span></h1>
  <p class="owl-hero-sub">Verifiable credentials, selective disclosure, and zero-knowledge predicates —<br/>built on Midnight. Drop Owl ID into your product in five minutes.</p>
  <div class="owl-cta-row">
    <a href="/quickstart" class="owl-btn owl-btn--primary">Get started →</a>
    <a href="/apps" class="owl-btn owl-btn--outline">Try the wallet</a>
  </div>
</div>

## What you get

<div class="owl-cards">
  <div class="owl-card">
    <div class="owl-card__icon">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
    </div>
    <div class="owl-card__title">Selective disclosure</div>
    <div class="owl-card__desc">Reveal only the attributes you pick. Hidden fields stay hashed under a salted Merkle root signed by the issuer.</div>
  </div>
  <div class="owl-card">
    <div class="owl-card__icon">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
    </div>
    <div class="owl-card__title">Zero-knowledge predicates</div>
    <div class="owl-card__desc">Prove "age ≥ 18", "nationality ∈ EU set", or "KYC tier ≥ 2" without revealing the underlying value. Groth16 over BLS12-381.</div>
  </div>
  <div class="owl-card">
    <div class="owl-card__icon">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>
    </div>
    <div class="owl-card__title">WebAuthn passkeys</div>
    <div class="owl-card__desc">ECDSA P-256 signing inside the secure enclave. Private keys never touch JavaScript or your servers.</div>
  </div>
  <div class="owl-card">
    <div class="owl-card__icon">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
    </div>
    <div class="owl-card__title">Live revocation registry</div>
    <div class="owl-card__desc">Revoke, suspend, reactivate. Verifiers receive push events over WebSocket — invalidate cached results instantly.</div>
  </div>
  <div class="owl-card">
    <div class="owl-card__icon">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>
    </div>
    <div class="owl-card__title">Plug-in IdP issuance</div>
    <div class="owl-card__desc">DigiD, BankID, OIDC, SAML, and Didit KYC out of the box. Bring your own provider via the form, OIDC, or webhook flows.</div>
  </div>
  <div class="owl-card">
    <div class="owl-card__icon">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    </div>
    <div class="owl-card__title">On-chain trust anchor</div>
    <div class="owl-card__desc">Issuer keys, revocations, and identity commitments published on Midnight. No central directory, no key escrow.</div>
  </div>
</div>

## Where to start

| You're a…  | Read                                          |
| ---------- | --------------------------------------------- |
| Verifier   | [Verifier integration](/integration/verifier) |
| Issuer     | [Issuer integration](/integration/issuer)     |
| Holder app | [Holder integration](/integration/holder)     |

Next steps: [Quickstart](/quickstart) · [SDK reference](/sdk/verifier) · [How Owl ID works](/architecture/overview)
