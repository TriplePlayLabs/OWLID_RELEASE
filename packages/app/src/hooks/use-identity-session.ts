import { Store, useStore } from '@tanstack/react-store'
import type { IdentityData } from '@owlid/sdk'

// Session-scoped, never persisted: holds the decrypted IdentityData while
// the user is signed in. Cleared on `resetDemo()` and on browser refresh
// (so unlocking is required again on every reload — the desired security
// posture).
interface IdentitySession {
  identityData: IdentityData | null
}

const identitySessionStore = new Store<IdentitySession>({ identityData: null })

export function setIdentityData(identityData: IdentityData | null) {
  identitySessionStore.setState((s) => ({ ...s, identityData }))
}

export function clearIdentitySession() {
  identitySessionStore.setState(() => ({ identityData: null }))
}

export function useIdentityData(): IdentityData | null {
  return useStore(identitySessionStore, (s) => s.identityData)
}
