/**
 * Smoke test for the public SDK surface.
 * Verifies: types resolve, classes instantiate, methods exist with the
 * right shapes. Does NOT hit a live server.
 */
import {
  OwlVerifier,
  OwlIssuer,
  EU_ALPHA2,
  proveCredentialWithPasskey,
  proveCredential,
  respondToPresentation,
  type VerificationResult,
  type IssuanceSession,
  type HolderSigner,
  type PresentationConsentRequest,
} from '@owlid/sdk'

function expect(condition: boolean, msg: string): void {
  if (!condition) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  console.log('PASS:', msg)
}

// 1. Constructor argument validation.
let threw = false
try {
  // @ts-expect-error apiKey missing on purpose
  new OwlVerifier({})
} catch {
  threw = true
}
expect(threw, 'OwlVerifier throws when apiKey missing')

threw = false
try {
  // @ts-expect-error apiKey missing on purpose
  new OwlIssuer({})
} catch {
  threw = true
}
expect(threw, 'OwlIssuer throws when apiKey missing')

// 2. Construction with apiKey only.
const verifier = new OwlVerifier({ apiKey: 'owlid_sk_test_smoke' })
const issuer = new OwlIssuer({ apiKey: 'owlid_sk_test_smoke' })

expect(typeof verifier.verify === 'function', 'OwlVerifier.verify exists')
expect(typeof verifier.mintChallenge === 'function', 'OwlVerifier.mintChallenge exists')
expect(typeof verifier.openPresentation === 'function', 'OwlVerifier.openPresentation exists')
expect(typeof verifier.requestPresentation === 'function', 'OwlVerifier.requestPresentation exists')
expect(
  typeof verifier.subscribeRevocations === 'function',
  'OwlVerifier.subscribeRevocations exists',
)
expect(typeof verifier.revocationFeedUrl === 'function', 'OwlVerifier.revocationFeedUrl exists')
expect(typeof verifier.listIssuers === 'function', 'OwlVerifier.listIssuers exists')

expect(typeof issuer.startSession === 'function', 'OwlIssuer.startSession exists')
expect(typeof issuer.submitClaims === 'function', 'OwlIssuer.submitClaims exists')
expect(typeof issuer.issue === 'function', 'OwlIssuer.issue exists')
expect(typeof issuer.poll === 'function', 'OwlIssuer.poll exists')
expect(typeof issuer.getSession === 'function', 'OwlIssuer.getSession exists')
expect(typeof issuer.getClaims === 'function', 'OwlIssuer.getClaims exists')
expect(typeof issuer.info === 'function', 'OwlIssuer.info exists')
expect(typeof issuer.listProviders === 'function', 'OwlIssuer.listProviders exists')

// 3. Static helpers.
expect(typeof respondToPresentation === 'function', 'respondToPresentation exported')
expect(typeof proveCredential === 'function', 'proveCredential exported')
expect(typeof proveCredentialWithPasskey === 'function', 'proveCredentialWithPasskey exported')

// 4. Reference data.
expect(EU_ALPHA2.includes('NL'), 'EU_ALPHA2 contains NL')
expect(EU_ALPHA2.length === 27, 'EU_ALPHA2 has 27 members')

// 5. revocationFeedUrl returns a ws URL.
const wsUrl = verifier.revocationFeedUrl()
expect(
  wsUrl.startsWith('ws://') || wsUrl.startsWith('wss://'),
  `revocationFeedUrl returns ws(s) URL: ${wsUrl}`,
)
expect(wsUrl.includes('/ws/revocations'), 'revocationFeedUrl ends with /ws/revocations')

// 6. Type-only validation — these compile only if types are public.
const _consent: PresentationConsentRequest = {
  verifierName: 'Test',
  requestedPredicates: [{ id: 'isOver18', label: 'Over 18' }],
  requestedDisclosures: [],
  sessionId: 'sid',
  nonce: 'nonce',
  timestamp: 0,
}
const _signer: HolderSigner = { type: 'passkey', credentialId: 'cred', publicKeyHex: 'abcd' }
const _result: VerificationResult = { valid: true, subjects: { age: 30 } }
const _session: Omit<IssuanceSession, 'start'> = {
  id: 'sid',
  providerId: 'didit',
  status: 'pending',
  flowType: 'webhook_async',
  expiresAt: '2026-01-01T00:00:00Z',
}
void _consent
void _signer
void _result
void _session

console.log('\nAll smoke checks passed.')
