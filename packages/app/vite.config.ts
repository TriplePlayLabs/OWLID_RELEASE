import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitroV2Plugin } from '@tanstack/nitro-v2-vite-plugin'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import wasm from 'vite-plugin-wasm'

const config = defineConfig({
  // Workspace-root .env (shared VITE_* across services + frontends).
  envDir: '../..',
  server: {
    port: 5000,
    allowedHosts: ['.trycloudflare.com', '.sashoush.dev'],
  },
  plugins: [
    wasm(),
    // COOP/COEP headers for SharedArrayBuffer (required for WASM threads)
    {
      name: 'configure-response-headers',
      configureServer: (server) => {
        server.middlewares.use((_req, res, next) => {
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
          next()
        })
      },
    },
    devtools(),
    nitroV2Plugin(),
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
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
    // Externalize native modules — they can't run in SSR
    external: [
      '@owlid/native-sdk',
      '@owlid/native-sdk-wasm32-wasi',
      '@owlid/native-sdk-linux-x64-gnu',
      '@napi-rs/wasm-runtime',
    ],
    // Let Vite bundle the SDK so it can tree-shake away native imports
    // that aren't used in the SSR render path
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

export default config
