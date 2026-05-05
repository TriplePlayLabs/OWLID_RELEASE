# Bundler & WASM setup

`@owlid/sdk` is split so REST-only consumers don't pay the WASM cost.

| Package                  | Pulls WASM? | Use when                                                                                  |
| ------------------------ | ----------- | ----------------------------------------------------------------------------------------- |
| `@owlid/config`          | no          | shared config (URLs, API key) — every app                                                 |
| `@owlid/issuer-client`   | no          | issuer REST endpoints                                                                     |
| `@owlid/verifier-client` | no          | verifier REST endpoints                                                                   |
| `@owlid/admin-client`    | no          | operator-only endpoints (admin auth, GDPR, manage-issuers, manage-revocations, metrics)   |
| `@owlid/sdk` (root)      | no          | presentation helpers, types, storage, WebAuthn helpers, encoding utils, config re-export  |
| `@owlid/sdk/native`      | **yes**     | proof / token generation primitives (`Token`, `Credential`, `PreparedToken`, `blake3`, …) |

Importing `@owlid/sdk` does **not** load the WASM module. The runtime
classes live behind the explicit `@owlid/sdk/native` subpath — opt in only
when you need to generate proofs locally.

## Who needs `@owlid/sdk/native`

Anything that **generates** proofs or tokens locally — typically the
holder's wallet UI, or CLI tools that build tokens out of band.

If your app only **calls** the verification or issuance REST endpoints, you
do not need the native subpath. Stick to the REST clients (or
`@owlid/sdk` root for the higher-level helpers) and your bundle stays
WASM-free.

## Vite

Apps that import `@owlid/sdk/native` need a bundler that handles WASM. Use
`vite-plugin-wasm` and exclude the native packages from pre-bundling:

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import wasm from 'vite-plugin-wasm'

export default defineConfig({
  plugins: [
    wasm(),
    // SharedArrayBuffer (some WASM threads use it) requires cross-origin isolation.
    {
      name: 'owlid-coop-coep',
      configureServer: (server) => {
        server.middlewares.use((_req, res, next) => {
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
          next()
        })
      },
    },
  ],
  optimizeDeps: {
    exclude: [
      '@owlid/sdk',
      '@owlid/native-sdk',
      '@owlid/native-sdk-wasm32-wasi',
      '@napi-rs/wasm-runtime',
    ],
  },
  ssr: {
    external: [
      '@owlid/native-sdk',
      '@owlid/native-sdk-wasm32-wasi',
      '@owlid/native-sdk-linux-x64-gnu',
      '@napi-rs/wasm-runtime',
    ],
    noExternal: ['@owlid/sdk'],
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      external: [
        '@owlid/native-sdk',
        '@owlid/native-sdk-wasm32-wasi',
        '@owlid/native-sdk-linux-x64-gnu',
        '@napi-rs/wasm-runtime',
      ],
    },
  },
})
```

## Vite — REST-only apps

If you only call REST endpoints, drop the wasm plugin and tell Vite not to
pre-bundle the native chunks:

```ts
// vite.config.ts (REST-only)
import { defineConfig } from 'vite'

export default defineConfig({
  optimizeDeps: {
    exclude: ['@owlid/native-sdk', '@owlid/native-sdk-wasm32-wasi', '@napi-rs/wasm-runtime'],
  },
  ssr: {
    external: [
      '@owlid/native-sdk',
      '@owlid/native-sdk-wasm32-wasi',
      '@owlid/native-sdk-linux-x64-gnu',
      '@napi-rs/wasm-runtime',
    ],
  },
  build: {
    rollupOptions: {
      external: [
        '@owlid/native-sdk',
        '@owlid/native-sdk-wasm32-wasi',
        '@owlid/native-sdk-linux-x64-gnu',
        '@napi-rs/wasm-runtime',
      ],
    },
  },
})
```

The `optimizeDeps.exclude` is the load-bearing line — without it Vite
attempts to pre-optimize a transitive WASM dep that never resolves and the
dev server 404s on `*.wasm32-wasi.wasm`.

## Webpack / Next.js

Webpack handles WASM via its `experiments.asyncWebAssembly` flag plus
`webpack.IgnorePlugin` for the absent native binary platforms:

```js
// next.config.js
import webpack from 'webpack'

export default {
  webpack: (config) => {
    config.experiments = { ...config.experiments, asyncWebAssembly: true }
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /^@owlid\/native-sdk-(linux|darwin|win32|freebsd|android)/,
      }),
    )
    return config
  },
}
```

REST-only Next.js apps can also drop `@owlid/sdk` entirely and import the
clients directly; that path needs no special bundler config.

## Configuration

Every package — clients and SDK alike — reads runtime configuration from
`@owlid/config`:

```ts
import { configure } from '@owlid/config'

configure({
  verificationUrl: 'https://api.owlid.example.com',
  issuerUrl: 'https://issuer.owlid.example.com',
  apiKey: process.env.OWLID_API_KEY,
})
```

Resolution order: explicit override → `configure()` call →
`window.__OWLID_CONFIG__` → `import.meta.env.VITE_*` →
`process.env.OWLID_*` / `VITE_*` → localhost defaults.
