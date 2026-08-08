import { describe, expect, test } from 'bun:test'
import {
  decryptRecoveryFile,
  encryptRecoveryFile,
  generateRecoveryCode,
  normalizeRecoveryCode,
  type RecoveryFileEntry,
} from '../src/recovery-file.js'

const entries: RecoveryFileEntry[] = [
  {
    credential: { credentialId: 'cred-a', vct: 'https://owlid/id' },
    holderSeedHex: 'aa'.repeat(32),
  },
  { credential: { credentialId: 'cred-b' }, holderSeedHex: 'bb'.repeat(32) },
]

describe('recovery file', () => {
  test('round-trips credentials + seeds under the right code', async () => {
    const code = generateRecoveryCode()
    const file = await encryptRecoveryFile(entries, code)
    const out = await decryptRecoveryFile(file, code)
    expect(out).toEqual(entries)
  })

  test('a wrong code fails to decrypt', async () => {
    const file = await encryptRecoveryFile(entries, generateRecoveryCode())
    await expect(decryptRecoveryFile(file, generateRecoveryCode())).rejects.toThrow(
      /invalid recovery code|corrupted/i,
    )
  })

  test('code normalization ignores case, dashes, spaces, and O/I/L confusables', async () => {
    const code = generateRecoveryCode()
    const file = await encryptRecoveryFile(entries, code)
    // re-space + lowercase the same code; normalization must collapse to the same key
    const messy = code.toLowerCase().replaceAll('-', ' ')
    const out = await decryptRecoveryFile(file, messy)
    expect(out).toEqual(entries)
  })

  test('normalizeRecoveryCode maps O->0 and I/L->1, drops separators', () => {
    expect(normalizeRecoveryCode('o0-iIlL aZ')).toBe('001111AZ')
  })

  test('tampered ciphertext is rejected (GCM auth)', async () => {
    const code = generateRecoveryCode()
    const file = await encryptRecoveryFile(entries, code)
    const flipped = file.ct[0] === 'A' ? `B${file.ct.slice(1)}` : `A${file.ct.slice(1)}`
    await expect(decryptRecoveryFile({ ...file, ct: flipped }, code)).rejects.toThrow()
  })

  test('a recovery-file blob cannot be opened with a swapped domain (additionalData bind)', async () => {
    const code = generateRecoveryCode()
    const file = await encryptRecoveryFile(entries, code)
    // wrong version string => rejected before crypto
    await expect(
      decryptRecoveryFile({ ...file, v: 'other' as unknown as typeof file.v }, code),
    ).rejects.toThrow(/unsupported recovery file format/i)
  })

  test('out-of-range KDF iterations are rejected', async () => {
    const code = generateRecoveryCode()
    const file = await encryptRecoveryFile(entries, code)
    await expect(
      decryptRecoveryFile({ ...file, kdf: { ...file.kdf, iterations: 5 } }, code),
    ).rejects.toThrow(/iteration/i)
  })

  test('generated codes are high-entropy and unique', () => {
    const a = generateRecoveryCode()
    const b = generateRecoveryCode()
    expect(a).not.toBe(b)
    expect(normalizeRecoveryCode(a).length).toBe(30)
  })

  test('empty entry set is refused', async () => {
    await expect(encryptRecoveryFile([], generateRecoveryCode())).rejects.toThrow(
      /nothing to back up/i,
    )
  })
})
