/**
 * QA regression: raw backend/client errors ("DCQL credential cred0 not
 * satisfied", "Response returned an error code") surfaced verbatim to
 * operators. Pins the friendly mappings.
 */
import { describe, expect, test } from 'bun:test'
import { friendlyVerifyError, friendlyApiError } from '../src/error-messages'

describe('friendlyVerifyError', () => {
  test('maps DCQL not-satisfied to plain language', () => {
    expect(friendlyVerifyError('DCQL credential cred0 not satisfied')).toMatch(
      /doesn't hold a credential/i,
    )
    expect(friendlyVerifyError('DCQL credential_set unsatisfied: [["a"]]')).toMatch(
      /doesn't hold a credential/i,
    )
  })

  test('maps the generated-client default message', () => {
    expect(friendlyVerifyError('Response returned an error code')).toMatch(/rejected the request/i)
  })

  test('passes real messages through and tolerates empty input', () => {
    expect(friendlyVerifyError('Challenge expired')).toBe('Challenge expired')
    expect(friendlyVerifyError(undefined)).toBeUndefined()
    expect(friendlyVerifyError(null)).toBeUndefined()
  })
})

describe('friendlyApiError', () => {
  function responseError(status: number, body?: unknown): Error & { response: Response } {
    const response = new Response(body === undefined ? null : JSON.stringify(body), { status })
    return Object.assign(new Error('Response returned an error code'), { response })
  }

  test('prefers the body error field', async () => {
    const err = responseError(400, { error: 'Invalid credential id format' })
    expect(await friendlyApiError(err, 'fallback')).toBe('Invalid credential id format')
  })

  test('falls back to a status description when the body is empty', async () => {
    expect(await friendlyApiError(responseError(404), 'fallback')).toMatch(/not found/i)
    expect(await friendlyApiError(responseError(500), 'fallback')).toMatch(/internal error/i)
    expect(await friendlyApiError(responseError(403), 'fallback')).toMatch(/API key/i)
  })

  test('uses the fallback for non-Response errors with the opaque client message', async () => {
    expect(await friendlyApiError(new Error('Response returned an error code'), 'fallback')).toBe(
      'fallback',
    )
    expect(await friendlyApiError(new Error('network down'), 'fallback')).toBe('network down')
  })
})
