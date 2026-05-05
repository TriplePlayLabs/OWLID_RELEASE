/**
 * OwlID runtime configuration.
 *
 *   import { configure, getConfig } from '@owlid/config'
 *
 *   configure({
 *     verificationUrl: 'https://api.owlid.example.com',
 *     issuerUrl: 'https://issuer.owlid.example.com',
 *     apiKey: process.env.OWLID_API_KEY,
 *   })
 *
 * Once configured, every Owl client package (`@owlid/issuer-client`,
 * `@owlid/verifier-client`, `@owlid/admin-client`) and the
 * `getVerificationUrl()` / `getIssuerUrl()` helpers honour the values you set.
 *
 * For deployments that prefer dynamic config (one Docker image → many envs)
 * the SDK ALSO reads `window.__OWLID_CONFIG__` (typed `RuntimeConfig`). The
 * shipped Docker images set this via `docker/runtime-config.sh`, which
 * writes `/config.js` from container env vars at startup.
 *
 * Resolution order (first non-empty wins):
 *   1. Explicit `override` argument to a getter
 *   2. Last call to `configure()` (in-memory)
 *   3. `window.__OWLID_CONFIG__` (set by `/config.js` or test fixtures)
 *   4. `import.meta.env.VITE_*` (Vite build-time inline)
 *   5. `process.env.OWLID_*` / `process.env.VITE_*` (Node / SSR)
 *   6. Built-in localhost defaults (dev only — warns in prod)
 */

export interface RuntimeConfig {
  /** Verification service base URL (HTTP/HTTPS), e.g. `https://api.owlid.example.com`. */
  verificationUrl?: string
  /** Issuer service base URL (HTTP/HTTPS), e.g. `https://issuer.owlid.example.com`. */
  issuerUrl?: string
  /** API key sent in the `Authorization: Bearer …` header. */
  apiKey?: string
  /**
   * Override for the WebSocket base URL. By default the SDK derives this from
   * `verificationUrl` (`http(s):` → `ws(s):`). Set this only when WS should
   * hit a different host than HTTP (rare; e.g. an LB that splits the traffic).
   */
  wsBaseUrl?: string
}

declare global {
  interface Window {
    __OWLID_CONFIG__?: RuntimeConfig
  }
}

let runtimeConfig: Readonly<RuntimeConfig> = Object.freeze({})

/**
 * Set the runtime configuration. Call once at app startup before any API
 * call. Calling again replaces the previous configuration entirely. Pass an
 * empty object to clear (useful in tests).
 */
export function configure(config: RuntimeConfig): void {
  runtimeConfig = Object.freeze({ ...config })
}

/** Read the merged runtime configuration currently in effect. */
export function getConfig(): Readonly<RuntimeConfig> {
  return Object.freeze({
    verificationUrl: getVerificationUrl(),
    issuerUrl: getIssuerUrl(),
    apiKey: getApiKey(),
    wsBaseUrl: getWsBaseUrl(),
  })
}

// -----------------------------------------------------------------------------
// Resolution helpers
// -----------------------------------------------------------------------------

function readMemory<K extends keyof RuntimeConfig>(key: K): RuntimeConfig[K] | undefined {
  return runtimeConfig[key]
}

function readWindow<K extends keyof RuntimeConfig>(key: K): RuntimeConfig[K] | undefined {
  if (typeof window === 'undefined') return undefined
  return window.__OWLID_CONFIG__?.[key]
}

function readImportMeta(name: string): string | undefined {
  if (typeof import.meta === 'undefined') return undefined
  const env = (import.meta as { env?: Record<string, string | undefined> }).env
  return env?.[name]
}

function readProcess(...names: string[]): string | undefined {
  if (typeof process === 'undefined') return undefined
  for (const n of names) {
    const v = process.env?.[n]
    if (v) return v
  }
  return undefined
}

function resolve(
  windowKey: keyof RuntimeConfig,
  envName: string,
  defaultValue?: string,
  override?: string,
): string | undefined {
  if (override) return override
  const fromMemory = readMemory(windowKey)
  if (fromMemory) return fromMemory
  const fromWindow = readWindow(windowKey)
  if (fromWindow) return fromWindow
  const fromMeta = readImportMeta(envName)
  if (fromMeta) return fromMeta
  const fromProcess = readProcess(envName, envName.replace(/^VITE_/, 'OWLID_'))
  if (fromProcess) return fromProcess
  return defaultValue
}

// -----------------------------------------------------------------------------
// Defaults and getters
// -----------------------------------------------------------------------------

const DEFAULT_VERIFICATION_URL = 'http://localhost:8000'
const DEFAULT_ISSUER_URL = 'http://localhost:8001'

let warnedDefault = false
function warnIfFellBack(label: string, used: string, fallback: string): void {
  if (warnedDefault || used !== fallback) return
  if (typeof window === 'undefined') return
  const host = window.location?.hostname
  if (!host || host === 'localhost' || host === '127.0.0.1') return
  warnedDefault = true
  // eslint-disable-next-line no-console
  console.warn(
    `[@owlid/config] ${label} fell back to ${used}. Call configure({ ${label}: '...' }) at app startup, or set the corresponding env var, before making API calls.`,
  )
}

/** Verification service base URL (HTTP). Default `http://localhost:8000`. */
export function getVerificationUrl(override?: string): string {
  const url = resolve(
    'verificationUrl',
    'VITE_VERIFICATION_URL',
    DEFAULT_VERIFICATION_URL,
    override,
  )!
  warnIfFellBack('verificationUrl', url, DEFAULT_VERIFICATION_URL)
  return url
}

/** Issuer service base URL (HTTP). Default `http://localhost:8001`. */
export function getIssuerUrl(override?: string): string {
  const url = resolve('issuerUrl', 'VITE_ISSUER_URL', DEFAULT_ISSUER_URL, override)!
  warnIfFellBack('issuerUrl', url, DEFAULT_ISSUER_URL)
  return url
}

export function getApiKey(override?: string): string | undefined {
  return resolve('apiKey', 'VITE_API_KEY', undefined, override) || undefined
}

export function apiKeyHeaders(key: string | undefined): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {}
}

/**
 * WebSocket base URL. If `wsBaseUrl` is set explicitly (in `configure()`,
 * `window.__OWLID_CONFIG__`, or `VITE_WS_BASE_URL`), use it; otherwise
 * derive from `getVerificationUrl()` by swapping `http(s):` → `ws(s):`.
 */
export function getWsBaseUrl(override?: string): string {
  const explicit = resolve('wsBaseUrl', 'VITE_WS_BASE_URL', undefined, override)
  if (explicit) return explicit
  return toWsUrl(getVerificationUrl())
}

/**
 * Convert any HTTP(S) URL to its WebSocket equivalent.
 * `http://x:8000` → `ws://x:8000`, `https://x` → `wss://x`.
 */
export function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http(s?):/i, 'ws$1:')
}

/**
 * Resolve a `SessionEngagement.ws.url` to an absolute WebSocket URL.
 * Accepts both relative paths (`/ws/foo`) and pre-absolute `ws(s)://` URLs.
 * If `base` is supplied as `http(s)://…`, it is converted to `ws(s)://…`.
 */
export function resolveWsUrl(pathOrUrl: string, base?: string): string {
  if (/^wss?:\/\//i.test(pathOrUrl)) return pathOrUrl
  const baseUrl = base ?? getWsBaseUrl()
  const wsBase = toWsUrl(baseUrl).replace(/\/$/, '')
  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`
  return `${wsBase}${path}`
}
