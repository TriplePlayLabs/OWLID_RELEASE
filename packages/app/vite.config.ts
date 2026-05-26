import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitroV2Plugin } from '@tanstack/nitro-v2-vite-plugin'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

// @owlid/sdk re-exports the holder-device predicate primitives
// (`predicate-proving`, `predicate-snapshot`, `predicate-assets`, …).
// Those transitively import `@midnight-ntwrk/zkir-v2`,
// `@midnight-ntwrk/ledger-v8`, `@midnight-ntwrk/compact-runtime`, and
// `@midnight-ntwrk/compact-js`, each of which ships `.wasm` modules via
// the ESM-integration-proposal pattern. Vite's default loader rejects
// that with "ESM integration proposal for Wasm is not supported" —
// vite-plugin-wasm + vite-plugin-top-level-await translate the imports.
// Pre-bundling those packages corrupts the inlined WASM binding, so
// they're excluded from the optimizer.

const config = defineConfig({
  // Workspace-root .env (shared VITE_* across services + frontends).
  envDir: '../..',
  server: {
    port: 5000,
    allowedHosts: ['.trycloudflare.com', '.sashoush.dev'],
  },
  plugins: [
    devtools(),
    nitroV2Plugin({
      // Rollup runs `external` before plugins, so the WASM-bearing
      // midnight packages never reach the SSR/Nitro builder either.
      rollupConfig: {
        external: (id: string) => /@midnight-ntwrk\/zkir-v2/.test(id),
      },
    }),
    wasm(),
    topLevelAwait(),
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
  optimizeDeps: {
    // Only the packages with direct `.wasm` ESM imports are excluded —
    // pre-bundling them corrupts the inlined wasm binding. The other
    // midnight packages (compact-runtime, compact-js, ledger-v8) import
    // CJS deps like `object-inspect` and MUST be pre-bundled so Vite
    // can transform `import x from 'cjs-module'` into something the
    // browser accepts.
    exclude: ['@midnight-ntwrk/zkir-v2'],
  },
  ssr: {
    external: ['@midnight-ntwrk/zkir-v2'],
  },
  build: {
    target: 'esnext',
  },
})

export default config
