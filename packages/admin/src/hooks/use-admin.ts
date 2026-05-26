import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getAdminApi,
  type AdminUserInfo,
  type ApiKeyInfo,
  type AuditEventInfo,
  type CreateApiKeyRequest,
  type CreateAdminUserRequest,
} from '@owlid/admin-client'

const adminApi = () => getAdminApi()

// --- API keys --------------------------------------------------------------

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

// --- Audit trail -----------------------------------------------------------

export interface AuditFilters {
  limit?: number
  entityType?: string
  eventType?: string
}

export function useAuditEvents(filters: AuditFilters = {}) {
  return useQuery<AuditEventInfo[]>({
    queryKey: ['admin', 'audit', filters],
    queryFn: () =>
      adminApi().listAuditEvents({
        limit: filters.limit ?? 100,
        entityType: filters.entityType || undefined,
        eventType: filters.eventType || undefined,
      }),
    refetchInterval: 20_000,
  })
}

// --- Admin users -----------------------------------------------------------

export function useAdminUsers() {
  return useQuery<AdminUserInfo[]>({
    queryKey: ['admin', 'users'],
    queryFn: () => adminApi().listAdminUsers(),
    refetchInterval: 30_000,
  })
}

export function useCreateAdminUser() {
  const queryClient = useQueryClient()
  return useMutation<AdminUserInfo, Error, CreateAdminUserRequest>({
    mutationFn: (createAdminUserRequest) => adminApi().createAdminUser({ createAdminUserRequest }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  })
}

export function useDeactivateAdminUser() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: (id) => adminApi().deactivateAdminUser({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  })
}
