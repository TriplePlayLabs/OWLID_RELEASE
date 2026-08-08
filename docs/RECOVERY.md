# Wallet Recovery & Multi-Device

How a holder keeps access to their credentials across passkey loss and multiple
devices, and the `@owlid/sdk` API integrators use to build their own flow.

## The three protection layers

| Layer                     | Key               | Survives                                                    | Where                                              |
| ------------------------- | ----------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| At-rest wrap              | WebAuthn PRF      | local theft (XSS) — blob is useless without the passkey     | `owl_wallet_key:<id>` in localStorage              |
| Server backup (opt-in)    | WebAuthn PRF      | reinstall / new device **with the same synced passkey**     | issuer `/recovery`, restored after re-verification |
| **Offline recovery file** | **recovery code** | **passkey loss / never-synced passkey, and any new device** | a file the user keeps                              |

The first two are gated by the passkey PRF: if the passkey is lost or was never
synced (iOS "this device only"), neither can be opened and the credentials are
orphaned. The **offline recovery file** closes that gap — it is encrypted under a
high-entropy recovery code with no passkey in the loop, so it restores onto a
brand-new device with a brand-new passkey. That same property makes it the
**multi-device** path: restore on a second device to mirror the wallet.

## Crypto

- Recovery code: 150-bit, Crockford base32 (no `I L O U`), shown as
  `A1B2C-D3E4F-…`. Input is normalized (case-insensitive, dashes/spaces ignored,
  `O→0`, `I/L→1`) before key derivation.
- KEK: `PBKDF2-SHA256` (600k iterations, random 16-byte salt) → `AES-256-GCM`
  (random 12-byte IV). Domain tag `owlid:recovery-file:v1` is bound as GCM
  additional-data (see [DOMAIN_SEPARATION.md](DOMAIN_SEPARATION.md), tag 13).
- The recovery code is the **only** key. Lose it and the file is useless; share
  it and the file is exposed. It is shown once and never persisted.

This is proportionate for a _credential_ wallet: there are no funds to drain, so
the threat model is lighter than a value-bearing wallet's. A threshold or
social-recovery scheme is deliberately out of scope.

## SDK API

### Ready-made (most integrators)

```ts
import { createRecoveryFile, restoreRecoveryFile } from '@owlid/sdk'

// Back up every credential in the local store. One passkey prompt reads the
// at-rest seeds; `file` + `code` are passkey-independent.
const { file, code, count } = await createRecoveryFile()
download(JSON.stringify(file)) // hand the file to the user
show(code) // show ONCE; never store it

// Restore on any device (incl. a fresh one) — only the code is needed. Seeds
// are re-wrapped under THIS device's passkey for at-rest storage.
const restored = await restoreRecoveryFile(fileText, code)
```

Both accept an optional `PasskeyCeremony` so a host app can serialize concurrent
passkey prompts or drive UI around the WebAuthn ceremony; omit it and the op runs
directly:

```ts
await createRecoveryFile((op) => withMyPromptGuard(op))
```

The OwlID app's wiring is the reference: `packages/app/src/lib/credential-recovery.ts`
(injects the app ceremony) + `packages/app/src/components/RecoveryFileCard.tsx`.

### Low-level (build your own store)

If you don't use the OwlID local credential store, compose the file crypto
directly:

```ts
import { generateRecoveryCode, encryptRecoveryFile, decryptRecoveryFile } from '@owlid/sdk'

const code = generateRecoveryCode()
const file = await encryptRecoveryFile(
  [{ credential, holderSeedHex }], // your entries
  code,
)
const entries = await decryptRecoveryFile(file, code)
```

A wrong code or any tampering fails `decryptRecoveryFile` (GCM auth) — the two
are indistinguishable by design.
