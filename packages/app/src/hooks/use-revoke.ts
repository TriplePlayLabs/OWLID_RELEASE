import { useMutation } from '@tanstack/react-query'
import { OwlWallet, storage } from '@owlid/sdk'
import { currentPasskeyId, unwrapWalletHolderKey } from '~/lib/passkeys'
import { withPasskeyCeremony } from '~/lib/wallet-session'

/** The wallet wired with the app's passkey-PRF unwrap — same construction
 *  as the presentation path. Each `revoke()` opens the credential's holder
 *  key behind a user-verification prompt. */
function buildWallet(): OwlWallet {
  return new OwlWallet(
    storage,
    async (passkeyId, wrapped) => unwrapWalletHolderKey(wrapped, passkeyId),
    currentPasskeyId,
  )
}

/** Revoke a single credential on-chain via holder proof-of-possession. */
export function useRevokeOwnCredential() {
  return useMutation({
    mutationFn: ({ credentialId, reason }: { credentialId: string; reason?: string }) =>
      withPasskeyCeremony(() => buildWallet().revoke(credentialId, reason)),
  })
}

/**
 * Revoke every credential currently in the wallet (used by "Reset & also
 * report lost"). Runs sequentially so the passkey prompts are ordered and a
 * mid-list failure doesn't leave half-finished parallel ceremonies. Throws on
 * the first failure so the caller can keep the local data (and let the holder
 * retry) instead of wiping a credential that wasn't actually revoked.
 */
export async function revokeAllCredentials(reason?: string): Promise<string[]> {
  const wallet = buildWallet()
  const creds = await storage.listCredentials()
  const revoked: string[] = []
  await withPasskeyCeremony(async () => {
    for (const c of creds) {
      const r = await wallet.revoke(c.credentialId, reason)
      revoked.push(r.credentialId)
    }
  })
  return revoked
}
