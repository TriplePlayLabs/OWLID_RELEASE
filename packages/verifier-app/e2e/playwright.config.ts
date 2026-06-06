import { defineConfig, devices } from '@playwright/test'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FAKE_VIDEO_PATH = join(here, 'fixtures', 'engagement-qr.y4m')

/**
 * Real e2e: boots the verifier-app dev server and drives the actual user
 * flow (scan -> connect -> pick checks -> send) in Chromium with a fake
 * camera. All backend traffic is network-mocked in the specs.
 */
export default defineConfig({
  testDir: '.',
  globalSetup: './global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5001',
    permissions: ['camera'],
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-video-capture=${FAKE_VIDEO_PATH}`,
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun run dev',
    cwd: join(here, '..'),
    url: 'http://localhost:5001',
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    // Hermetic config: a publishable key so getVerifierApiKey() resolves.
    // The verification host is the app's own origin so mocked REST calls
    // (`/health`, `/predicates`) are same-origin — no CORS to satisfy. The
    // WS URL comes from the scanned QR, not config, so it stays fake.
    env: {
      VITE_VERIFIER_API_KEY: 'owlid_pk_e2e',
      VITE_API_KEY: 'owlid_pk_e2e',
      VITE_VERIFICATION_URL: 'http://localhost:5001',
    },
  },
})
