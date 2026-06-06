import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'

mock.module('@owlid/sdk', () => ({
  configure: () => {},
  getConfig: () => ({
    verificationUrl: '',
    issuerUrl: '',
    apiKey: '',
    wsBaseUrl: '',
  }),
}))

let settings: typeof import('../src/lib/settings')

beforeAll(async () => {
  settings = await import('../src/lib/settings')
})

afterEach(() => {
  localStorage.clear()
})

describe('settings', () => {
  test('defaults encrypted recovery to off for older stored settings', () => {
    localStorage.setItem(
      'owlid:settings:v1',
      JSON.stringify({ provingMode: 'wasm', proofServerUrl: '' }),
    )

    expect(settings.loadSettings().encryptedRecoveryEnabled).toBe(false)
  })

  test('persists encrypted recovery opt-in', () => {
    settings.saveSettings({
      provingMode: 'wasm',
      proofServerUrl: '',
      encryptedRecoveryEnabled: true,
    })

    expect(settings.loadSettings().encryptedRecoveryEnabled).toBe(true)
  })
})

// Regression for QA #6 — the "Effective backend" preview echoed an
// invalid URL (e.g. `ftp://…`) as if it were active even while Save /
// Test were disabled by the same validation error.
describe('effectiveBackendLabel (#6)', () => {
  const op = 'https://proofs.owlid.app'

  test('wasm mode never mentions a proof server', () => {
    expect(
      settings.effectiveBackendLabel({ mode: 'wasm', url: '', operatorUrl: op }),
    ).not.toContain('proof server')
  })

  test('invalid URL is NOT echoed back as effective', () => {
    const label = settings.effectiveBackendLabel({
      mode: 'proof-server',
      url: 'ftp://evil.example',
      operatorUrl: op,
    })
    expect(label).not.toContain('ftp://')
    expect(label).toContain('valid URL')
  })

  test('plain-http non-localhost (blocked) is not echoed', () => {
    const label = settings.effectiveBackendLabel({
      mode: 'proof-server',
      url: 'http://insecure.example',
      operatorUrl: op,
    })
    expect(label).not.toContain('http://insecure.example')
  })

  test('valid custom URL is shown, normalized (no trailing slash)', () => {
    const label = settings.effectiveBackendLabel({
      mode: 'proof-server',
      url: 'https://my-prover.example/',
      operatorUrl: op,
    })
    expect(label).toBe('proof server → https://my-prover.example')
  })

  test('blank URL falls back to the operator default', () => {
    const label = settings.effectiveBackendLabel({
      mode: 'proof-server',
      url: '',
      operatorUrl: op,
    })
    expect(label).toBe(`proof server → ${op}`)
  })
})
