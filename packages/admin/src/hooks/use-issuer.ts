import { useQuery } from '@tanstack/react-query'
import { getInfoApi, getProvidersApi, getOidcApi, getSessionsApi } from '~/lib/api'
import type { IssuerInfoResponse, OidcProviderInfo, SessionResponse } from '@owlid/sdk'

export function useIssuerHealth() {
  return useQuery<string>({
    queryKey: ['issuer', 'health'],
    queryFn: () => getInfoApi().health(),
    refetchInterval: 30_000,
  })
}

export function useIssuerInfo() {
  return useQuery<IssuerInfoResponse>({
    queryKey: ['issuer', 'info'],
    queryFn: () => getInfoApi().getIssuerInfo(),
  })
}

export function useProviders() {
  return useQuery<Array<{ id: string; name: string; type: string }>>({
    queryKey: ['issuer', 'providers'],
    // listProviders returns Promise<Array<any>> in the generated client
    queryFn: () => getProvidersApi().listProviders(),
  })
}

export function useOidcProviders() {
  return useQuery<OidcProviderInfo[]>({
    queryKey: ['issuer', 'oidc-providers'],
    queryFn: () => getOidcApi().listOidcProviders(),
  })
}

export function useSession(id: string) {
  return useQuery<SessionResponse>({
    queryKey: ['issuer', 'session', id],
    queryFn: () => getSessionsApi().getSession({ id }),
    enabled: !!id,
  })
}
