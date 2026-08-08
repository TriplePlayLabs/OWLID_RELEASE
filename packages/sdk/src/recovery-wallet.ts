// Offline wallet recovery + multi-device, built on the recovery-file crypto.
//
// This is the reusable core: an integrator embedding @owlid/sdk gets working
// backup/restore without re-implementing the storage <-> passkey-wrap <->
// encrypted-file plumbing. The only host-specific concern is how a passkey
// prompt is presented; pass a `ceremony` to serialize prompts or drive UI, or
// omit it and the op runs directly.

import {
  decryptRecoveryFile,
  encryptRecoveryFile,
  generateRecoveryCode,
  type RecoveryFile,
} from './recovery-file.js'
import { storage, type WalletCredential } from './storage.js'
import { openHolderKeys, sealHolderKeys } from './webauthn.js'

export interface ExportedRecoveryFile {
  /** Encrypted, serializable file — write to disk / cloud as-is. */
  file: RecoveryFile
  /** The recovery code — the ONLY key. Show once; never persist it. */
  code: string
  /** How many credentials the file holds. */
  count: number
}

/**
 * Wraps a passkey-prompting op so the host can serialize concurrent prompts or
 * drive UI around the WebAuthn ceremony. Defaults to running the op directly,
 * so the SDK works standalone.
 */
export type PasskeyCeremony = <T>(op: () => Promise<T>) => Promise<T>

const runDirectly: PasskeyCeremony = (op) => op()

async function currentPasskeyId(): Promise<string | null> {
  return (await storage.loadWebAuthnCredential())?.credentialId ?? null
}

/**
 * Build an encrypted offline recovery file for every credential in the wallet.
 * One passkey prompt reads the at-rest holder seeds; the resulting `file` and
 * `code` are passkey-independent, so the file restores even if the passkey is
 * later lost or was never synced. Show `code` once and hand `file` to the user.
 */
export async function createRecoveryFile(
  ceremony: PasskeyCeremony = runDirectly,
): Promise<ExportedRecoveryFile> {
  const credentials = await storage.listCredentials()
  if (credentials.length === 0) throw new Error('No credentials to back up')

  const wrapped: string[] = []
  for (const cred of credentials) {
    const blob = await storage.getCredentialKeyWrapped(cred.credentialId)
    if (!blob) throw new Error(`Missing wrapped key for credential ${cred.credentialId}`)
    wrapped.push(blob)
  }

  const { seedHexes, credentialId } = await ceremony(async () =>
    openHolderKeys(await currentPasskeyId(), wrapped),
  )
  await storage.saveSelectedWebAuthnCredential(credentialId)

  const entries = credentials.map((credential, i) => ({ credential, holderSeedHex: seedHexes[i] }))
  const code = generateRecoveryCode()
  const file = await encryptRecoveryFile(entries, code)
  return { file, code, count: credentials.length }
}

/**
 * Restore credentials from a recovery file using the recovery code. No prior
 * passkey is needed — the seeds are re-wrapped under THIS device's passkey (one
 * prompt) for local at-rest storage. This is also the multi-device path: run it
 * on a second device to mirror the wallet there. Returns the credentials stored.
 */
export async function restoreRecoveryFile(
  fileText: string,
  code: string,
  ceremony: PasskeyCeremony = runDirectly,
): Promise<WalletCredential[]> {
  let file: RecoveryFile
  try {
    file = JSON.parse(fileText) as RecoveryFile
  } catch {
    throw new Error('That file is not a valid OwlID recovery file')
  }

  const entries = await decryptRecoveryFile(file, code)
  const credentials = entries.map((e) => e.credential as WalletCredential)

  const { blobs, credentialId } = await ceremony(async () =>
    sealHolderKeys(
      await currentPasskeyId(),
      entries.map((e) => e.holderSeedHex),
    ),
  )
  await storage.saveSelectedWebAuthnCredential(credentialId)

  const restored: WalletCredential[] = []
  for (let i = 0; i < credentials.length; i++) {
    try {
      await storage.addCredential(credentials[i], blobs[i])
      restored.push(credentials[i])
    } catch (error) {
      console.warn('Failed to store restored credential', error)
    }
  }
  return restored
}
