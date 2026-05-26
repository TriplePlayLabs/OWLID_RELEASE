import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getInfoApi,
  getOidcApi,
  getSessionsApi,
  type IssuerInfoResponse,
  type OidcProviderInfo,
  type ProviderInfo,
  type SessionResponse,
} from '@owlid/issuer-client'
import { getIssuerAdminApi, type ProviderToggleResponse } from '@owlid/admin-client'

/** Same shape as `HealthProbe` in use-verification.ts; duplicated here to
 * keep the hooks self-contained without adding cross-hook imports. */
export interface IssuerHealthProbe {
  ok: boolean
  latencyMs: number
}

export function useIssuerHealth() {
  return useQuery<IssuerHealthProbe>({
    queryKey: ['issuer', 'health'],
    queryFn: async () => {
      const started = performance.now()
      try {
        await getInfoApi().health()
        return { ok: true, latencyMs: Math.round(performance.now() - started) }
      } catch {
        return { ok: false, latencyMs: Math.round(performance.now() - started) }
      }
    },
    refetchInterval: 15_000,
  })
}

export function useIssuerInfo() {
  return useQuery<IssuerInfoResponse>({
    queryKey: ['issuer', 'info'],
    queryFn: () => getInfoApi().getIssuerInfo(),
    // Issuer identity (public key, name) is effectively static for the
    // lifetime of the service. No interval polling — single fetch is
    // sufficient. React-Query refetches on mount as needed.
    staleTime: 5 * 60_000,
  })
}

export function useProviders() {
  return useQuery<ProviderInfo[]>({
    queryKey: ['issuer', 'providers'],
    // Admin-only endpoint that includes disabled providers (the public
    // `/providers` filters them out so holders never see a disabled IdP).
    queryFn: () => getIssuerAdminApi().listAllProviders(),
    // Refresh so an enable/disable flip from another seat shows up
    // without reload.
    refetchInterval: 30_000,
  })
}

export function useToggleProvider() {
  const qc = useQueryClient()
  return useMutation<ProviderToggleResponse, Error, { id: string; enable: boolean }>({
    mutationFn: ({ id, enable }) =>
      enable
        ? getIssuerAdminApi().enableProvider({ id })
        : getIssuerAdminApi().disableProvider({ id }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['issuer', 'providers'] }),
  })
}

export function useOidcProviders() {
  return useQuery<OidcProviderInfo[]>({
    queryKey: ['issuer', 'oidc-providers'],
    queryFn: () => getOidcApi().listOidcProviders(),
    refetchInterval: 30_000,
  })
}

export function useSession(id: string) {
  return useQuery<SessionResponse>({
    queryKey: ['issuer', 'session', id],
    queryFn: () => getSessionsApi().getSession({ id }),
    enabled: !!id,
  })
}
