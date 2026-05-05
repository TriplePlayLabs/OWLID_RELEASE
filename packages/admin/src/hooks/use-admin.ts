import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getAdminApi, type ApiKeyInfo, type CreateApiKeyRequest } from '@owlid/admin-client'

const adminApi = () => getAdminApi()

export function useApiKeys() {
  return useQuery<ApiKeyInfo[]>({
    queryKey: ['admin', 'api-keys'],
    queryFn: () => adminApi().listApiKeys(),
    refetchInterval: 30_000,
  })
}

export function useCreateApiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (createApiKeyRequest: CreateApiKeyRequest) =>
      adminApi().createApiKey({ createApiKeyRequest }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'api-keys'] }),
  })
}

export function useDeactivateApiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => adminApi().deactivateApiKey({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'api-keys'] }),
  })
}
