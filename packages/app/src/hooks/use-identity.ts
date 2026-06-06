import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { storage } from '@owlid/sdk'

const USERNAME_KEY = ['identity', 'username'] as const
const HAS_CRED_KEY = ['identity', 'has-credential'] as const
const PASSKEY_KEY = ['identity', 'passkey'] as const

/**
 * Bootstrap-state hook for the holder app. Reads:
 *   - username       — wallet display label
 *   - passkey        — local WebAuthn credentialId hint for the unlock gate
 *   - has-credential — at least one wallet credential present
 *
 * Always refetches on mount + window focus so the cache can't lie after
 * the user wipes storage from DevTools.
 */
export function useIdentity() {
  const qc = useQueryClient()

  const usernameQuery = useQuery({
    queryKey: USERNAME_KEY,
    queryFn: () => storage.loadUsername(),
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  })

  const hasCredential = useQuery({
    queryKey: HAS_CRED_KEY,
    queryFn: () => storage.hasAnyCredential(),
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  })

  const passkey = useQuery({
    queryKey: PASSKEY_KEY,
    queryFn: () => storage.loadWebAuthnCredential(),
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  })

  const completeRegistrationMut = useMutation({
    mutationFn: ({ username }: { username: string }) => storage.saveUsername(username),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['identity'] }),
  })

  return {
    username: usernameQuery.data ?? '',
    /** Local WebAuthn credentialId hint. Null lets the browser show the passkey picker. */
    credentialId: passkey.data?.credentialId ?? null,
    isRegistered: !!passkey.data,
    isIdentityCreated: !!hasCredential.data,
    isBootstrapping: usernameQuery.isPending || hasCredential.isPending || passkey.isPending,

    completeRegistration: (username: string) => completeRegistrationMut.mutateAsync({ username }),

    resetDemo: async () => {
      await storage.clearAll()
      window.location.reload()
    },
  }
}
