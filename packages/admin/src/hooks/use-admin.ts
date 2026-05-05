import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

const VERIFICATION_URL =
  import.meta.env.VITE_VERIFICATION_URL || import.meta.env.VITE_API_URL || 'http://localhost:8000'

function getToken(): string | null {
  return localStorage.getItem('admin_token')
}

function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// Login
export function useAdminLogin() {
  return useMutation({
    mutationFn: async (credentials: { username: string; password: string }) => {
      const resp = await fetch(`${VERIFICATION_URL}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Login failed' }))
        throw new Error(err.error || 'Login failed')
      }
      return resp.json() as Promise<{ token: string; username: string; expiresIn: number }>
    },
  })
}

// List API keys
export function useApiKeys() {
  return useQuery({
    queryKey: ['admin', 'api-keys'],
    queryFn: async () => {
      const resp = await fetch(`${VERIFICATION_URL}/admin/api-keys`, {
        headers: authHeaders(),
      })
      if (!resp.ok) throw new Error('Failed to fetch API keys')
      return resp.json() as Promise<
        Array<{
          id: string
          name: string
          description: string | null
          permissions: string[]
          isActive: boolean
          createdAt: string
          lastUsedAt: string | null
          createdBy: string | null
        }>
      >
    },
    enabled: !!getToken(),
  })
}

// Create API key
export function useCreateApiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (data: { name: string; description?: string; permissions: string[] }) => {
      const resp = await fetch(`${VERIFICATION_URL}/admin/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(data),
      })
      if (!resp.ok) throw new Error('Failed to create API key')
      return resp.json() as Promise<{ key: string; name: string; permissions: string[] }>
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'api-keys'] }),
  })
}

// Deactivate API key
export function useDeactivateApiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const resp = await fetch(`${VERIFICATION_URL}/admin/api-keys/${id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      })
      if (!resp.ok) throw new Error('Failed to deactivate API key')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'api-keys'] }),
  })
}
