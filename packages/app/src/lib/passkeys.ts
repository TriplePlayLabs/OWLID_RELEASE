import {
  bufferToBase64url,
  openHolderKey,
  openRecoveryBundle,
  openRecoveryBundles,
  registerCredential,
  sealHolderKey,
  sealHolderKeys,
  sealRecoveryBundle,
  storage,
  type WebAuthnRegistrationResult,
} from '@owlid/sdk'
import { withPasskeyCeremony } from '~/lib/wallet-session'

const DEFAULT_TRANSPORTS = ['internal', 'hybrid']

export async function registerWalletPasskey(username: string): Promise<WebAuthnRegistrationResult> {
  const existing = await storage.loadWebAuthnCredential()
  const result = await withPasskeyCeremony(() =>
    registerCredential({
      rpName: 'Owl ID Demo',
      rpId: window.location.hostname,
      userName: username,
      userDisplayName: username,
      authenticatorAttachment: 'platform',
      userVerification: 'required',
      residentKey: 'required',
      attestation: 'none',
      excludeCredentialIds: existing?.credentialId ? [existing.credentialId] : undefined,
    }),
  )
  await storage.saveWebAuthnCredential({
    credentialId: result.credentialId,
    publicKey: result.publicKey,
    counter: result.counter,
    transports: result.transports,
  })
  return result
}

export async function rememberSelectedPasskey(credentialId: string): Promise<void> {
  await storage.saveSelectedWebAuthnCredential(credentialId, DEFAULT_TRANSPORTS)
}

export async function rememberAssertionPasskey(assertion: PublicKeyCredential): Promise<void> {
  await rememberSelectedPasskey(bufferToBase64url(assertion.rawId))
}

export async function currentPasskeyId(): Promise<string | null> {
  return (await storage.loadWebAuthnCredential())?.credentialId ?? null
}

export async function wrapWalletHolderKey(seedHex: string): Promise<string> {
  const { blob, credentialId } = await withPasskeyCeremony(async () =>
    sealHolderKey(await currentPasskeyId(), seedHex),
  )
  await rememberSelectedPasskey(credentialId)
  return blob
}

/** Wrap several holder seeds under one passkey prompt (order preserved). */
export async function wrapWalletHolderKeys(seedHexes: string[]): Promise<string[]> {
  const { blobs, credentialId } = await withPasskeyCeremony(async () =>
    sealHolderKeys(await currentPasskeyId(), seedHexes),
  )
  await rememberSelectedPasskey(credentialId)
  return blobs
}

export async function unwrapWalletHolderKey(
  wrappedHolderSeed: string,
  passkeyCredentialId?: string | null,
): Promise<string> {
  const { seedHex, credentialId } = await withPasskeyCeremony(async () =>
    openHolderKey(passkeyCredentialId ?? (await currentPasskeyId()), wrappedHolderSeed),
  )
  await rememberSelectedPasskey(credentialId)
  return seedHex
}

export async function encryptRecoveryPayload(payload: string): Promise<string> {
  const { blob, credentialId } = await withPasskeyCeremony(async () =>
    sealRecoveryBundle(await currentPasskeyId(), payload),
  )
  await rememberSelectedPasskey(credentialId)
  return blob
}

export async function decryptRecoveryPayload(
  ciphertext: string,
  passkeyCredentialId?: string | null,
): Promise<string> {
  const { payload, credentialId } = await withPasskeyCeremony(async () =>
    openRecoveryBundle(passkeyCredentialId ?? (await currentPasskeyId()), ciphertext),
  )
  await rememberSelectedPasskey(credentialId)
  return payload
}

/** Decrypt several recovery blobs under one passkey prompt (gaps removed). */
export async function decryptRecoveryPayloads(
  ciphertexts: string[],
  passkeyCredentialId?: string | null,
): Promise<string[]> {
  const { payloads, credentialId } = await withPasskeyCeremony(async () =>
    openRecoveryBundles(passkeyCredentialId ?? (await currentPasskeyId()), ciphertexts),
  )
  await rememberSelectedPasskey(credentialId)
  return payloads
}
