/**
 * Regression for GH #11 — "Age within range isn't a proper number field,
 * it should just say 30 not 030".
 *
 * The age threshold / min / max inputs were bound to a JS `number` and
 * coerced every keystroke through `Number(e.target.value)`, which let a
 * stray leading "0" stick on mobile (empty → 0 → "03…"). They are now
 * string-backed and run through `sanitizeAge`, which strips leading zeros.
 *
 * `../api` is mocked so the registry resolves without the verification
 * service; `@owlid/sdk` is stubbed to the country helpers the component
 * imports, keeping the wallet / native-sdk / WASM out of the suite.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const REGISTRY = [
  {
    id: 'age:gte',
    attribute: 'age',
    label: 'Is over a minimum age',
    op: 'GreaterOrEqual',
    route: 'age_over_18',
    value: '18',
  },
  {
    id: 'age:range',
    attribute: 'age',
    label: 'Age is within a range',
    op: 'Range',
    route: 'age_range',
    value: '',
  },
]

mock.module('../src/api', () => ({
  listPredicates: () => Promise.resolve(REGISTRY),
}))
mock.module('@owlid/sdk', () => ({
  ALL_COUNTRIES: [],
  COUNTRY_PRESETS: [],
  countryName: (c: string) => c,
  getApiKey: () => 'owlid_pk_test',
}))

const { PredicateSelector, sanitizeAge } = await import('../src/components/PredicateSelector')

beforeEach(() => {
  cleanup()
})

/** Reveal the age:range sub-inputs by toggling its row on. */
async function openAgeRange() {
  const onSubmit = mock(() => {})
  render(<PredicateSelector onSubmit={onSubmit} onCancel={() => {}} />)
  const row = await screen.findByText('Age is within a range')
  fireEvent.click(row)
  const min = (await screen.findByLabelText('From')) as HTMLInputElement
  const max = screen.getByLabelText('to') as HTMLInputElement
  return { onSubmit, min, max }
}

describe('sanitizeAge', () => {
  test('strips a leading zero typed before a number', () => {
    expect(sanitizeAge('030')).toBe('30')
    expect(sanitizeAge('007')).toBe('7')
  })
  test('keeps a lone zero and an already-clean number', () => {
    expect(sanitizeAge('0')).toBe('0')
    expect(sanitizeAge('30')).toBe('30')
  })
  test('drops non-digits', () => {
    expect(sanitizeAge('3a0')).toBe('30')
    expect(sanitizeAge('')).toBe('')
  })
})

describe('PredicateSelector age range field (#11)', () => {
  test('renders "30" not "030" when a leading zero is typed', async () => {
    const { min } = await openAgeRange()
    fireEvent.change(min, { target: { value: '030' } })
    await waitFor(() => expect(min.value).toBe('30'))
    expect(min.value).not.toBe('030')
  })

  test('passes numeric min/max to onSubmit', async () => {
    const { onSubmit, min, max } = await openAgeRange()
    fireEvent.change(min, { target: { value: '030' } })
    fireEvent.change(max, { target: { value: '45' } })

    fireEvent.click(screen.getByRole('button', { name: /send request/i }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const params = onSubmit.mock.calls[0][3] as Map<string, { min: number; max: number }>
    expect(params.get('age:range')).toEqual({ min: 30, max: 45 })
  })
})

describe('PredicateSelector age threshold field (#11)', () => {
  test('renders "21" not "021" and submits a number', async () => {
    const onSubmit = mock(() => {})
    render(<PredicateSelector onSubmit={onSubmit} onCancel={() => {}} />)
    fireEvent.click(await screen.findByText('Is over a minimum age'))
    const input = (await screen.findByLabelText('Minimum age')) as HTMLInputElement
    fireEvent.change(input, { target: { value: '021' } })
    await waitFor(() => expect(input.value).toBe('21'))

    fireEvent.click(screen.getByRole('button', { name: /send request/i }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const params = onSubmit.mock.calls[0][3] as Map<string, { threshold: number }>
    expect(params.get('age:gte')).toEqual({ threshold: 21 })
  })
})
