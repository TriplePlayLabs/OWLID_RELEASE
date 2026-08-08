/**
 * Map raw backend / generated-client errors to operator-readable text.
 *
 * The generated OpenAPI client throws `ResponseError` whose `message` is
 * always the literal "Response returned an error code" — the actual
 * reason lives in the response body's `error` field. Server-side DCQL
 * errors ("DCQL credential cred0 not satisfied") are developer-facing;
 * verifiers at a door need plain language.
 */

const DCQL_NOT_SATISFIED = /^DCQL credential (\S+) not satisfied$/
const DCQL_SET_UNSATISFIED = /^DCQL credential_set unsatisfied/
const NOT_ATTESTED = /not attested on Midnight/

export function friendlyVerifyError(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined
  if (DCQL_NOT_SATISFIED.test(raw) || DCQL_SET_UNSATISFIED.test(raw)) {
    return "The wallet doesn't hold a credential that can answer this request — the holder may need to add or re-verify the matching credential."
  }
  if (NOT_ATTESTED.test(raw)) {
    return "This check isn't anchored on Midnight for the presented credential — make sure the holder signed the same check you selected, or use the live QR session."
  }
  if (raw === 'Response returned an error code') {
    return 'The verification service rejected the request. Try again, and check the service status if it keeps failing.'
  }
  return raw
}

/** Extract the body `error` message from a generated-client ResponseError,
 *  falling back to a friendly status-code description. */
export async function friendlyApiError(err: unknown, fallback: string): Promise<string> {
  const response =
    err && typeof err === 'object' && 'response' in err
      ? (err as { response?: unknown }).response
      : null
  if (response instanceof Response) {
    let bodyError: string | undefined
    try {
      const json = (await response.clone().json()) as { error?: string }
      if (typeof json.error === 'string' && json.error.length > 0) bodyError = json.error
    } catch {
      /* non-JSON body */
    }
    if (bodyError) return bodyError
    if (response.status === 404) return 'Not found.'
    if (response.status === 401 || response.status === 403) {
      return 'The verifier API key was rejected — check the configuration.'
    }
    if (response.status >= 500) {
      return 'The verification service hit an internal error. Try again shortly.'
    }
    return `Request failed (HTTP ${response.status}).`
  }
  return err instanceof Error && err.message !== 'Response returned an error code'
    ? err.message
    : fallback
}
