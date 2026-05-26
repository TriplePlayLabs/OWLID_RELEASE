/**
 * Holder-app user settings (proving backend, advanced overrides).
 *
 * Persists to localStorage and bridges into `@owlid/sdk` via `configure()`
 * so every SDK code path (OwlWallet, the predicate orchestrator) picks
 * up the user's choice without prop-drilling.
 *
 * Defaults stay in code (proving mode = `wasm`, no remote URL). The user
 * can opt into a remote proof server at runtime; the choice survives a
 * reload because it lives in localStorage, not URL state.
 */

import { configure, getConfig, type ProvingMode } from '@owlid/sdk'

const STORAGE_KEY = 'owlid:settings:v1'

export interface AppSettings {
  provingMode: ProvingMode
  /** Empty string ⇒ use the operator default (`VITE_PROOF_SERVER_URL`). */
  proofServerUrl: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  provingMode: 'wasm',
  proofServerUrl: '',
}

/** Operator-suggested URL used when the user picks "proof server" but
 *  doesn't supply a custom endpoint. Resolved on every read so a late
 *  `window.__OWLID_CONFIG__` injection (TanStack Start ships it in an
 *  inline script that may race with module evaluation) is not stuck on
 *  an empty fallback:
 *    1. `window.__OWLID_CONFIG__.proofServerUrl` (Cloud Run env at boot)
 *    2. `import.meta.env.VITE_PROOF_SERVER_URL` (build-time fallback) */
export function getOperatorProofServerUrl(): string {
  if (typeof window !== 'undefined' && window.__OWLID_CONFIG__?.proofServerUrl) {
    return window.__OWLID_CONFIG__.proofServerUrl
  }
  if (typeof import.meta !== 'undefined') {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env
    return env?.VITE_PROOF_SERVER_URL ?? ''
  }
  return ''
}

/** Read settings from localStorage; returns defaults on SSR / first run. */
export function loadSettings(): AppSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    return {
      provingMode: parsed.provingMode === 'proof-server' ? 'proof-server' : 'wasm',
      proofServerUrl: typeof parsed.proofServerUrl === 'string' ? parsed.proofServerUrl : '',
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

/** Persist settings + push them into `@owlid/config` so the SDK picks
 *  them up on the next call. */
export function saveSettings(next: AppSettings): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  applySettingsToSdk(next)
}

/** Sync the in-memory `@owlid/config` runtime with the holder's settings.
 *  Must be called once on app boot (before the first `OwlWallet.present`)
 *  and after every change. Preserves the rest of the SDK config. */
export function applySettingsToSdk(settings: AppSettings): void {
  const current = getConfig()
  const url =
    settings.provingMode === 'proof-server'
      ? settings.proofServerUrl || getOperatorProofServerUrl() || undefined
      : undefined
  configure({
    verificationUrl: current.verificationUrl,
    issuerUrl: current.issuerUrl,
    apiKey: current.apiKey,
    wsBaseUrl: current.wsBaseUrl,
    provingMode: settings.provingMode,
    proofServerUrl: url,
  })
}

/** Did the operator configure a default proof server at build time? */
export function hasOperatorProofServer(): boolean {
  return getOperatorProofServerUrl().length > 0
}

/**
 * Validate a user-entered proof-server URL. Returns an error message
 * (string) on failure, or `null` if the URL is usable.
 *   - empty ⇒ ok (fall back to operator default)
 *   - must parse as a URL
 *   - protocol must be http or https
 *   - non-localhost over plain http blocked (mixed content + clear-text witness preimage)
 */
export function validateProofServerUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return 'Not a valid URL'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Must be http:// or https://'
  }
  const host = parsed.hostname
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')
  if (parsed.protocol === 'http:' && !isLocal) {
    return 'Plain http is only allowed for localhost — use https'
  }
  return null
}

/** Normalize a URL the user typed (trim, drop trailing slash). */
export function normalizeProofServerUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/**
 * Probe `${url}/version` to confirm the proof server answers and
 * (when CORS-fronted) responds for this Origin. Returns `{ ok, status, body }`
 * — the body is the trimmed text response (Midnight prover returns a JSON
 * version blob). Resolves with `ok=false` on network/CORS error; never throws.
 */
export async function pingProofServer(
  url: string,
  init?: { timeoutMs?: number },
): Promise<{ ok: boolean; status?: number; body?: string; error?: string }> {
  const normalized = normalizeProofServerUrl(url)
  if (!normalized) return { ok: false, error: 'URL is empty' }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), init?.timeoutMs ?? 8_000)
  try {
    const res = await fetch(`${normalized}/version`, {
      method: 'GET',
      mode: 'cors',
      signal: ac.signal,
    })
    const body = (await res.text()).slice(0, 200)
    return { ok: res.ok, status: res.status, body }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'network error',
    }
  } finally {
    clearTimeout(timer)
  }
}
