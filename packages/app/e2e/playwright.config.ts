import { defineConfig, devices } from '@playwright/test'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Real e2e for the holder app: boots the dev server and drives actual user
 * flows. Backend traffic is network-mocked per spec; identity state is
 * seeded into localStorage so flows behind the (WebAuthn-PRF) unlock gate
 * are reachable without a real authenticator.
 */
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5000',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun run dev',
    cwd: join(here, '..'),
    url: 'http://localhost:5000',
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: {
      VITE_ISSUER_URL: 'http://localhost:5000',
      VITE_VERIFICATION_URL: 'http://localhost:5000',
      VITE_API_KEY: 'owlid_pk_e2e',
    },
  },
})
