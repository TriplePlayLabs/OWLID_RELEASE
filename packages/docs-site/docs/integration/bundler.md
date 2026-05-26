# Bundler setup

`@owlid/sdk` is pure TypeScript — no WASM, no platform binaries. It works out of the box with any modern bundler (Vite, Webpack, Next.js, esbuild, Rollup, Bun) without WASM plugins or cross-origin-isolation headers.

| Package                  | Use when                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `@owlid/config`          | shared config (URLs, API key) — every app                                                |
| `@owlid/issuer-client`   | generated issuer REST client                                                             |
| `@owlid/verifier-client` | generated verifier REST client                                                           |
| `@owlid/admin-client`    | operator-only endpoints (admin auth, GDPR, manage-issuers, manage-revocations, metrics)  |
| `@owlid/sdk` (root)      | `OwlVerifier`, `OwlIssuer`, holder helpers, WebAuthn, storage, encoding, SD-JWT VC types |

The SDK builds SD-JWT VC bytes with `@noble/ed25519` + `@noble/hashes` — standard `application/dc+sd-jwt` wire format, so any conformant verifier accepts presentations minted from `@owlid/sdk` unchanged.

## Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({})
```

That's it — no WASM plugins, no `optimizeDeps.exclude`, no COOP/COEP headers.

## Webpack / Next.js

```js
// next.config.js
export default {}
```

Same story — no special config.

## Configuration

Every package — clients and SDK alike — reads runtime configuration from `@owlid/config`:

```ts
import { configure } from '@owlid/config'

configure({
  verificationUrl: 'https://api.owlid.example.com',
  issuerUrl: 'https://issuer.owlid.example.com',
  apiKey: process.env.OWLID_API_KEY,
})
```

Resolution order: explicit override → `configure()` call → `window.__OWLID_CONFIG__` → `import.meta.env.VITE_*` → `process.env.OWLID_*` / `VITE_*` → the hosted OwlID platform.
