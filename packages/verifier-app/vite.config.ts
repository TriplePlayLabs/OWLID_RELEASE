import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

export default defineConfig({
  // Read VITE_* vars from the workspace root .env (single source of truth
  // shared with backend / sidecar). Override per-package by adding a local
  // .env.local in this directory.
  envDir: '../..',
  plugins: [tailwindcss(), wasm(), topLevelAwait(), react()],
  // @owlid/sdk's index re-exports the holder-device predicate primitives
  // (`predicate-proving`, `predicate-snapshot`, …). Those transitively
  // import `@midnight-ntwrk/zkir-v2`, `@midnight-ntwrk/ledger-v8`, and
  // `@midnight-ntwrk/compact-runtime`, each of which ships `.wasm` modules
  // via the ESM-integration-proposal pattern. The verifier-app never
  // invokes the holder path at runtime, but Vite's dep pre-bundler still
  // walks the static imports — without vite-plugin-wasm + top-level-await
  // it 500s the dev server before the bundle is produced.
  // Only the packages with direct `.wasm` ESM imports are excluded —
  // pre-bundling them corrupts the inlined wasm binding. Other midnight
  // packages (compact-runtime, compact-js, ledger-v8) import CJS deps
  // like `object-inspect` and MUST be pre-bundled so Vite can translate
  // `import x from 'cjs-module'` to a working browser binding.
  optimizeDeps: {
    exclude: ['@midnight-ntwrk/zkir-v2'],
  },
  build: {
    target: 'esnext',
  },
  server: {
    port: 5001,
    allowedHosts: ['.trycloudflare.com', '.sashoush.dev'],
  },
})
