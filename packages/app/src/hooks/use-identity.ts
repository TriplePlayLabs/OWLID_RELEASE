import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { storage, type IdentityData } from '@owlid/sdk'
import { clearIdentitySession, setIdentityData, useIdentityData } from './use-identity-session'

const STORED_KEY = ['identity', 'stored'] as const
const HAS_CRED_KEY = ['identity', 'has-credential'] as const

export function useIdentity() {
  const qc = useQueryClient()
  const identityData = useIdentityData()

  const stored = useQuery({
    queryKey: STORED_KEY,
    queryFn: () => storage.loadStoredIdentity(),
    staleTime: Infinity,
  })

  const hasCredential = useQuery({
    queryKey: HAS_CRED_KEY,
    queryFn: () => storage.hasStoredCredential(),
    staleTime: Infinity,
  })

  const completeRegistrationMut = useMutation({
    mutationFn: ({ credentialId, username }: { credentialId: string; username: string }) =>
      storage.saveIdentity(credentialId, username),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['identity'] }),
  })

  const completeIdentityCreationMut = useMutation({
    mutationFn: async (newData: IdentityData) => {
      await storage.saveEncryptedIdentity(newData)
      return newData
    },
    onSuccess: (newData) => {
      setIdentityData(newData)
      qc.invalidateQueries({ queryKey: HAS_CRED_KEY })
    },
  })

  const unlockMut = useMutation({
    mutationFn: async (encryptedBlob: string) => storage.decryptIdentity(encryptedBlob),
    onSuccess: (decrypted) => setIdentityData(decrypted),
  })

  return {
    username: stored.data?.username ?? '',
    credentialId: stored.data?.credentialId ?? null,
    encryptedBlob: stored.data?.encryptedBlob ?? null,
    isRegistered: !!stored.data?.credentialId,
    isIdentityCreated: !!hasCredential.data,
    identityData,
    isBootstrapping: stored.isPending || hasCredential.isPending,

    completeRegistration: (credentialId: string, username: string) =>
      completeRegistrationMut.mutateAsync({ credentialId, username }),
    completeIdentityCreation: (d: IdentityData) => completeIdentityCreationMut.mutateAsync(d),
    unlockIdentity: (blob: string) => unlockMut.mutateAsync(blob),
    setIdentityData,
    resetDemo: async () => {
      clearIdentitySession()
      await storage.clearAll()
      window.location.reload()
    },
  }
}
