import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import wasm from 'vite-plugin-wasm'

export default defineConfig({
  plugins: [wasm(), tailwindcss(), react()],
  build: {
    target: 'esnext',
  },
  optimizeDeps: {
    exclude: [
      '@owlid/sdk',
      '@owlid/native-sdk',
      '@owlid/native-sdk-wasm32-wasi',
      '@napi-rs/wasm-runtime',
    ],
  },
  server: {
    port: 5001,
    allowedHosts: ['.trycloudflare.com', '.sashoush.dev'],
  },
})
