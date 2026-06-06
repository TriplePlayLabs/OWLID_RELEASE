import { describe, expect, test } from 'bun:test'
import { ensureCredentialPredicatesAttested } from '../src/midnight/orchestrator'

// A credential stamped with the email_verified predicate (kind `email`).
function credential(): string {
  return JSON.stringify({
    root_hash: 'aa'.repeat(32),
    attributes: { emailVerified: true },
    predicate_attestations: [{ predicate: 'email_verified' }],
  })
}

// `compiledContract` must never be reached when the snapshot fetch fails.
const assets = {
  compiledContract: () => {
    throw new Error('compiledContract reached despite snapshot failure')
  },
  zkConfigProvider: {},
} as never

describe('ensureCredentialPredicatesAttested', () => {
  test('a snapshot failure skips that predicate instead of aborting the run', async () => {
    const events: Array<{ stage: string; predicate?: string; reason?: string }> = []
    let relayCalls = 0
    const transport = {
      isAttested: async () => false,
      snapshot: async () => {
        throw new Error('sidecar 400: no public state at ed0e…')
      },
      relay: async () => {
        relayCalls += 1
        return { jobId: 'x', status: 'queued' }
      },
      statusEvents: async function* () {},
    } as never

    const results = await ensureCredentialPredicatesAttested(
      credential(),
      assets,
      transport,
      (e) => events.push(e as { stage: string }),
      [{ predicate: 'email_verified' }],
    )

    // Degrade, not crash: nothing attested, relay never reached, and the
    // failure surfaced as a per-predicate skip the verifier can reject on.
    expect(results).toEqual([])
    expect(relayCalls).toBe(0)
    const skip = events.find((e) => e.stage === 'skip-unsatisfiable')
    expect(skip).toBeDefined()
    expect(skip!.predicate).toBe('email_verified')
    expect(String(skip!.reason)).toContain('attestation prep failed')
  })

  test('an already-attested predicate short-circuits before any snapshot fetch', async () => {
    let snapshotCalls = 0
    const transport = {
      isAttested: async () => true,
      snapshot: async () => {
        snapshotCalls += 1
        throw new Error('should not be called')
      },
      relay: async () => ({ jobId: 'x', status: 'queued' }),
      statusEvents: async function* () {},
    } as never

    const results = await ensureCredentialPredicatesAttested(
      credential(),
      assets,
      transport,
      undefined,
      [{ predicate: 'email_verified' }],
    )

    expect(snapshotCalls).toBe(0)
    expect(results).toEqual([
      { predicate: 'email_verified', threshold: undefined, alreadyOnChain: true },
    ])
  })
})
