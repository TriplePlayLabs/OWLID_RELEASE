/**
 * QA regression: a generated SD-JWT presentation (~1.5–3 KB) exceeded
 * the QR byte capacity at ECC level H, qrcode.react threw
 * `RangeError: Data too long` during render, and the app-level error
 * boundary white-screened the whole wallet. OwlQrCode must (a) step
 * down ECC for long payloads, (b) render a copy fallback — never
 * throw — for payloads beyond any QR capacity.
 */
import { describe, expect, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { OwlQrCode, qrLevelFor, QR_BYTE_CAPACITY } from '../src/components/identity/OwlQrCode'

describe('qrLevelFor', () => {
  test('strongest level that fits, by byte-mode capacity boundaries', () => {
    expect(qrLevelFor(0)).toBe('H')
    expect(qrLevelFor(QR_BYTE_CAPACITY.H)).toBe('H')
    expect(qrLevelFor(QR_BYTE_CAPACITY.H + 1)).toBe('Q')
    expect(qrLevelFor(QR_BYTE_CAPACITY.Q + 1)).toBe('M')
    expect(qrLevelFor(QR_BYTE_CAPACITY.M + 1)).toBe('L')
    expect(qrLevelFor(QR_BYTE_CAPACITY.L)).toBe('L')
    expect(qrLevelFor(QR_BYTE_CAPACITY.L + 1)).toBeNull()
  })
})

describe('OwlQrCode', () => {
  test('renders an SVG QR for a small payload', () => {
    const { container } = render(<OwlQrCode value="OWLP:abc123" />)
    expect(container.querySelector('svg')).not.toBeNull()
  })

  test('renders a QR (no crash) for an SD-JWT-sized payload above the H capacity', () => {
    const payload = 'a'.repeat(2000) // between H (1273) and L (2953)
    const { container } = render(<OwlQrCode value={payload} />)
    expect(container.querySelector('svg')).not.toBeNull()
  })

  test('renders the copy fallback instead of throwing for an oversized payload', () => {
    const payload = 'a'.repeat(5000) // beyond any QR capacity
    const { container } = render(<OwlQrCode value={payload} />)
    // The QR module path carries the brand fg colour; the fallback's
    // lucide icons are SVGs too, so check for the QR specifically.
    expect(container.querySelector('svg path[fill="#0B0D12"]')).toBeNull()
    expect(screen.getByTestId('button-qr-copy-fallback')).toBeTruthy()
    expect(screen.getByText(/too large to display as a QR code/i)).toBeTruthy()
  })
})
