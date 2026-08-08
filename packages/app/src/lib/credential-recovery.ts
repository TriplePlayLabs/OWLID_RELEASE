import {
  createRecoveryFile,
  type ExportedRecoveryFile,
  restoreRecoveryFile,
  storage,
  type WalletCredential,
} from '@owlid/sdk'
import type { CredentialsApi } from '@owlid/issuer-client'
import {
  decryptRecoveryPayloads,
  encryptRecoveryPayload,
  wrapWalletHolderKeys,
} from '~/lib/passkeys'
import { loadSettings } from '~/lib/settings'
import { withPasskeyCeremony } from '~/lib/wallet-session'

export type { ExportedRecoveryFile }

const RECOVERY_VERSION = 'owlid-recovery-bundle-v1'
const RECOVERY_KEY_LABEL = 'passkey-prf-recovery-v1'

interface RecoveryBundle {
  version: typeof RECOVERY_VERSION
  credential: WalletCredential
  holderSeedHex: string
}

function parseRecoveryBundle(payload: string): RecoveryBundle {
  const parsed = JSON.parse(payload) as Partial<RecoveryBundle>
  if (parsed.version !== RECOVERY_VERSION || !parsed.credential || !parsed.holderSeedHex) {
    throw new Error('Recovery backup has an unsupported format')
  }
  return parsed as RecoveryBundle
}

export function isEncryptedRecoveryEnabled(): boolean {
  return loadSettings().encryptedRecoveryEnabled
}

export async function backupIssuedCredential({
  api,
  sessionId,
  credential,
  holderSeedHex,
}: {
  api: CredentialsApi
  sessionId: string
  credential: WalletCredential
  holderSeedHex: string
}): Promise<void> {
  if (!isEncryptedRecoveryEnabled()) return

  const bundle: RecoveryBundle = {
    version: RECOVERY_VERSION,
    credential,
    holderSeedHex,
  }
  const ciphertext = await encryptRecoveryPayload(JSON.stringify(bundle))
  await api.storeRecoveryBackup({
    id: sessionId,
    recoveryBackupRequest: {
      credentialId: credential.credentialId,
      ciphertext,
      encryptionVersion: RECOVERY_VERSION,
      keyLabel: RECOVERY_KEY_LABEL,
      metadata: {
        providerId: credential.providerId,
        issuer: credential.issuer,
      },
    },
  })
}

/**
 * Restore every credential backed up for this verified identity. Two passkey
 * prompts total regardless of count: one to decrypt all recovery blobs, one to
 * re-wrap all holder seeds for local at-rest storage. Returns the credentials
 * that were stored (empty when recovery is off or nothing is recoverable here).
 */
export async function restoreCredentialsFromVerifiedSession({
  api,
  sessionId,
}: {
  api: CredentialsApi
  sessionId: string
}): Promise<WalletCredential[]> {
  if (!isEncryptedRecoveryEnabled()) return []

  const backups = await api.listRecoveryBackups({ id: sessionId })
  if (backups.backups.length === 0) return []

  const payloads = await decryptRecoveryPayloads(backups.backups.map((b) => b.ciphertext))
  const bundles: RecoveryBundle[] = []
  for (const payload of payloads) {
    try {
      bundles.push(parseRecoveryBundle(payload))
    } catch (error) {
      console.warn('Skipping malformed recovery backup', error)
    }
  }
  if (bundles.length === 0) return []

  const wrapped = await wrapWalletHolderKeys(bundles.map((b) => b.holderSeedHex))
  const restored: WalletCredential[] = []
  for (let i = 0; i < bundles.length; i++) {
    try {
      await storage.addCredential(bundles[i].credential, wrapped[i])
      restored.push(bundles[i].credential)
    } catch (error) {
      console.warn('Failed to store restored credential', error)
    }
  }
  return restored
}

// ============================================================================
// Offline recovery file — passkey-independent backup the holder keeps.
//
// The core backup/restore lives in @owlid/sdk (`createRecoveryFile` /
// `restoreRecoveryFile`) so integrators can reuse it. These wrappers only inject
// the app's passkey ceremony (concurrent-prompt guard + UI). See
// docs/RECOVERY.md.
// ============================================================================

/** Build an offline recovery file for every credential in this wallet. */
export function exportWalletRecoveryFile(): Promise<ExportedRecoveryFile> {
  return createRecoveryFile(withPasskeyCeremony)
}

/** Restore credentials from an offline recovery file + recovery code. */
export function importWalletRecoveryFile(
  fileText: string,
  code: string,
): Promise<WalletCredential[]> {
  return restoreRecoveryFile(fileText, code, withPasskeyCeremony)
}
