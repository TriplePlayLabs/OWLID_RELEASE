import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import { nitroV2Plugin } from '@tanstack/nitro-v2-vite-plugin'

const config = defineConfig({
  // Workspace-root .env (shared VITE_* across services + frontends).
  envDir: '../..',
  server: {
    allowedHosts: ['.trycloudflare.com', '.sashoush.dev'],
  },
  ssr: {
    external: [
      '@owlid/native-sdk',
      '@owlid/native-sdk-wasm32-wasi',
      '@owlid/native-sdk-linux-x64-gnu',
      '@napi-rs/wasm-runtime',
    ],
  },
  plugins: [
    devtools(),
    nitroV2Plugin(),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
