/**
 * Regression for the recent-proofs crash: clicking a proof rendered its
 * full SD-JWT VC presentation into a level-H QR, which threw
 * `RangeError: Data too long` for any non-trivial proof and took down the
 * page. The view is now a read-only details panel — no QR — so an
 * arbitrarily large presentation renders fine.
 */
import { describe, expect, test, mock } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import type { StoredProof } from '@owlid/sdk'
import { ProofDetailsModal } from '../src/features/identity/proofs/ProofDetailsModal'

const proof: StoredProof = {
  id: 'p1',
  predicateId: 'age_over_18',
  name: 'Acme Bar',
  claim: 'Over 18',
  result: true,
  // Deliberately huge — the old QR path threw RangeError well below this.
  presentation: `eyJ.${'A'.repeat(8000)}~${'B'.repeat(4000)}~kbjwt`,
  createdAt: '2026-06-01T12:00:00.000Z',
  expiresAt: '2026-06-01T12:05:00.000Z',
}

describe('ProofDetailsModal — details, no QR (recent-proofs crash fix)', () => {
  test('renders a huge proof as details without throwing', () => {
    expect(() =>
      render(<ProofDetailsModal isOpen args={{ proof }} close={mock(() => {})} />),
    ).not.toThrow()

    expect(screen.getByText('Over 18')).toBeDefined()
    expect(screen.getByText('age_over_18')).toBeDefined()
    expect(screen.getByText('Satisfied')).toBeDefined()
    expect(screen.getByText('Acme Bar')).toBeDefined()
    // No QR is rendered anymore.
    expect(screen.queryByRole('img', { name: /proof qr/i })).toBeNull()
    cleanup()
  })

  test('failed proof shows "Not satisfied"', () => {
    render(
      <ProofDetailsModal
        isOpen
        args={{ proof: { ...proof, result: false } }}
        close={mock(() => {})}
      />,
    )
    expect(screen.getByText('Not satisfied')).toBeDefined()
    cleanup()
  })
})
