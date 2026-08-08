import { describe, expect, test, mock } from 'bun:test'

// Stub the real WASM prove so the relay/terminal-status paths are
// reachable without zkir. Tests that don't reach prove are unaffected.
mock.module('../src/midnight/prove', () => ({
  proveAttestationUnsubmitted: async () => new Uint8Array([1, 2, 3]),
}))

const { ensureCredentialPredicatesAttested } = await import('../src/midnight/orchestrator')

// A credential stamped with the email_verified predicate (kind `email`).
// Carries owl_root + the bound claim disclosure (`email_verified`) so the
// attestation key anchors on owl_root (F-1) as real credentials now do.
function credential(): string {
  return JSON.stringify({
    root_hash: 'aa'.repeat(32),
    owl_root: 'ab'.repeat(32),
    attributes: { emailVerified: true },
    claim_disclosures: [{ name: 'email_verified', value: true, salt: 'email-salt' }],
    predicate_attestations: [{ predicate: 'email_verified' }],
  })
}

// A credential stamped with unique_personhood (holder-only secret witness),
// with owl_root + the bound `personhoodSecret` disclosure.
function personhoodCredential(): string {
  return JSON.stringify({
    root_hash: 'aa'.repeat(32),
    owl_root: 'ac'.repeat(32),
    attributes: { personhoodSecret: 'cc'.repeat(32) },
    claim_disclosures: [{ name: 'personhoodSecret', value: 'cc'.repeat(32), salt: 'ph-salt' }],
    predicate_attestations: [{ predicate: 'unique_personhood' }],
  })
}

// A pre-owl_root credential (no `owl_root`) — can't satisfy any predicate.
function preOwlRootCredential(): string {
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

// A non-throwing assets for tests that legitimately reach the prove step.
const assetsOk = {
  compiledContract: () => ({}),
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

  // The /attested key binds the issuer-signed owl_root (F-1). The server
  // 400s ("owl_root required") if the query omits it, which aborts the
  // whole presentation — so the orchestrator must forward owl_root.
  test('forwards the issuer-signed owl_root in the attestation query', async () => {
    const owlRoot = 'ab'.repeat(32)
    let seen: { owlRoot?: string } | undefined
    const transport = {
      isAttested: async (q: { owlRoot?: string }) => {
        seen = q
        return true
      },
      snapshot: async () => ({}),
      relay: async () => ({ jobId: 'x', status: 'queued' }),
      statusEvents: async function* () {},
    } as never

    const credWithOwlRoot = JSON.stringify({
      root_hash: 'aa'.repeat(32),
      owl_root: owlRoot,
      attributes: { emailVerified: true },
      predicate_attestations: [{ predicate: 'email_verified' }],
    })

    await ensureCredentialPredicatesAttested(credWithOwlRoot, assets, transport, undefined, [
      { predicate: 'email_verified' },
    ])

    expect(seen?.owlRoot).toBe(owlRoot)
  })

  // A credential issued before owl_root binding can't satisfy any predicate:
  // the /attested key (and the on-chain key) bind owl_root, so the server
  // would 400 and abort the whole presentation. Skip it with a reissue hint
  // before any network call instead.
  test('a pre-owl_root credential is skipped with a reissue hint, never queried', async () => {
    const events: Array<{ stage: string; predicate?: string; reason?: string }> = []
    let isAttestedCalls = 0
    const transport = {
      isAttested: async () => {
        isAttestedCalls += 1
        return false
      },
      snapshot: async () => ({}),
      relay: async () => ({ jobId: 'x', status: 'queued' }),
      statusEvents: async function* () {},
    } as never

    const results = await ensureCredentialPredicatesAttested(
      preOwlRootCredential(),
      assets,
      transport,
      (e) => events.push(e as { stage: string }),
      [{ predicate: 'email_verified' }],
    )

    expect(results).toEqual([])
    expect(isAttestedCalls).toBe(0) // never queried — skipped before the round-trip
    const skip = events.find((e) => e.stage === 'skip-unsatisfiable')
    expect(skip?.predicate).toBe('email_verified')
    expect(String(skip?.reason)).toContain('owl_root')
  })

  // Cancel checkpoint: a holder who aborts (closes the modal / taps Cancel)
  // must not trigger an on-chain attest submit. A relay POST makes the
  // sidecar submit a tx detached, so relaying post-cancel writes to chain +
  // spends DUST. The orchestrator must throw an AbortError BEFORE snapshot
  // + relay, not run them.
  test('an already-aborted signal throws AbortError before snapshot/relay', async () => {
    let snapshotCalls = 0
    let relayCalls = 0
    const transport = {
      isAttested: async () => false,
      snapshot: async () => {
        snapshotCalls += 1
        return {}
      },
      relay: async () => {
        relayCalls += 1
        return { jobId: 'x', status: 'queued' }
      },
      statusEvents: async function* () {},
    } as never

    const controller = new AbortController()
    controller.abort()

    let thrown: unknown
    try {
      await ensureCredentialPredicatesAttested(
        credential(),
        assets,
        transport,
        undefined,
        [{ predicate: 'email_verified' }],
        undefined,
        controller.signal,
      )
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).name).toBe('AbortError')
    // The whole point: no snapshot fetch, no relay → no on-chain submit.
    expect(snapshotCalls).toBe(0)
    expect(relayCalls).toBe(0)
  })

  // Concurrent same-campaign personhood: a racing tx inserts the nullifier
  // first; the loser fails the on-chain `personhood replay` assert even
  // though the attestation it duplicates is on chain. The orchestrator must
  // re-check THIS credential's key and treat an already-attested key as
  // success instead of failing the whole presentation.
  test('a personhood-replay chain failure resolves as already-attested when the key is on chain', async () => {
    let isAttestedCalls = 0
    let relayCalls = 0
    const transport = {
      // 1st call (up-front check): not yet attested → prove + relay.
      // 2nd call (post-replay re-check): now on chain (racing tx landed).
      isAttested: async () => {
        isAttestedCalls += 1
        return isAttestedCalls >= 2
      },
      snapshot: async () => ({}),
      relay: async () => {
        relayCalls += 1
        return { jobId: 'job-1', status: 'queued' }
      },
      // Terminal chain failure: the racing tx already inserted the nullifier.
      statusEvents: async function* () {
        yield { status: 'FailEntirely', error: 'failed assert: personhood replay' }
      },
    } as never

    const results = await ensureCredentialPredicatesAttested(
      personhoodCredential(),
      assetsOk,
      transport,
      undefined,
      [
        {
          predicate: 'unique_personhood',
          epoch: 'bb'.repeat(32),
          appId: 'dd'.repeat(32),
          verifierId: 'https://verifier.example/campaign',
        },
      ],
    )

    expect(relayCalls).toBe(1)
    expect(isAttestedCalls).toBe(2) // up-front check + post-replay re-check
    expect(results).toEqual([
      { predicate: 'unique_personhood', threshold: undefined, alreadyOnChain: true },
    ])
  })

  // The same replay failure must NOT be swallowed when the key is genuinely
  // absent (a real, non-racy personhood failure) — that must still throw.
  test('a personhood-replay failure with the key still absent throws', async () => {
    const transport = {
      isAttested: async () => false, // never becomes attested
      snapshot: async () => ({}),
      relay: async () => ({ jobId: 'job-2', status: 'queued' }),
      statusEvents: async function* () {
        yield { status: 'FailEntirely', error: 'failed assert: personhood replay' }
      },
    } as never

    await expect(
      ensureCredentialPredicatesAttested(personhoodCredential(), assetsOk, transport, undefined, [
        {
          predicate: 'unique_personhood',
          epoch: 'bb'.repeat(32),
          appId: 'dd'.repeat(32),
          verifierId: 'https://verifier.example/campaign',
        },
      ]),
    ).rejects.toThrow(/personhood replay|failed/)
  })
})
