---
pageType: home
hero:
  name: OwlID
  text: Privacy-first digital identity
  tagline: Verifiable credentials, selective disclosure, zero-knowledge predicates — built on Midnight.
  actions:
    - theme: brand
      text: Get started
      link: /quickstart
    - theme: alt
      text: Try the wallet
      link: https://wallet.owlid.dev
features:
  - title: Selective disclosure
    details: Reveal only the attributes you pick. Hidden fields stay hashed under a salted Merkle root signed by the issuer.
    icon: 🪪
  - title: Zero-knowledge predicates
    details: Prove "age ≥ 18", "nationality ∈ EU set", or "KYC tier ≥ 2" without revealing the underlying value. Groth16 over BLS12-381.
    icon: 🔐
  - title: WebAuthn passkeys
    details: ECDSA P-256 signing inside the secure enclave. Private keys never touch JavaScript or your servers.
    icon: 🔑
  - title: Live revocation registry
    details: Revoke, suspend, reactivate. Verifiers receive push events over WebSocket — invalidate cached results instantly.
    icon: 🚫
  - title: Plug-in IdP issuance
    details: DigiD, BankID, OIDC, SAML, and Didit KYC out of the box. Bring your own provider via the form, OIDC, or webhook flows.
    icon: 🛂
  - title: On-chain trust anchor
    details: Issuer keys, revocations, and identity commitments published on Midnight. No central directory, no key escrow.
    icon: 🌙
---
