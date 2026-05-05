import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getIssuersApi,
  getMonitoringApi,
  getRevocationsApi,
  getVerificationApi,
  type CheckRevocationRequest,
  type CheckRevocationResponse,
  type RevocationEntry,
  type TrustedIssuerInfo,
  type VerifyResponse,
} from '@owlid/verifier-client'
import {
  getAdminIssuersApi,
  getAdminRevocationsApi,
  getGdprApi,
  getMetricsApi,
  type AddTrustedIssuerRequest,
  type AddTrustedIssuerResponse,
  type MetricsResponse,
  type ReactivateCredentialRequest,
  type RevokeCredentialRequest,
} from '@owlid/admin-client'

// ---------------------------------------------------------------------------
// Health (public read — verifier-client surface)
// ---------------------------------------------------------------------------

/**
 * Result of a health probe. `ok` is the boolean outcome; `latencyMs` is the
 * wall-clock round-trip the SPA observed and is rendered in the status card
 * so the operator can spot a degraded link before it goes down outright.
 */
export interface HealthProbe {
  ok: boolean
  latencyMs: number
}

export function useVerificationHealth() {
  return useQuery<HealthProbe>({
    queryKey: ['verification', 'health'],
    queryFn: async () => {
      const started = performance.now()
      try {
        await getMonitoringApi().health()
        return { ok: true, latencyMs: Math.round(performance.now() - started) }
      } catch {
        return { ok: false, latencyMs: Math.round(performance.now() - started) }
      }
    },
    refetchInterval: 15_000,
  })
}

// ---------------------------------------------------------------------------
// Metrics (admin)
// ---------------------------------------------------------------------------

export function useMetrics() {
  return useQuery<MetricsResponse>({
    queryKey: ['verification', 'metrics'],
    queryFn: () => getMetricsApi().getMetrics(),
    refetchInterval: 10_000,
  })
}

// ---------------------------------------------------------------------------
// Trusted Issuers
// ---------------------------------------------------------------------------

export function useTrustedIssuers() {
  return useQuery<TrustedIssuerInfo[]>({
    queryKey: ['verification', 'issuers'],
    queryFn: () => getIssuersApi().listTrustedIssuers(),
    // Operators may add issuers from another seat; keep the listing
    // fresh without forcing manual refresh.
    refetchInterval: 30_000,
  })
}

export function useAddTrustedIssuer() {
  const qc = useQueryClient()
  return useMutation<AddTrustedIssuerResponse, Error, AddTrustedIssuerRequest>({
    mutationFn: (req) => getAdminIssuersApi().addTrustedIssuer({ addTrustedIssuerRequest: req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['verification', 'issuers'] }),
  })
}

// ---------------------------------------------------------------------------
// Revocations
// ---------------------------------------------------------------------------

export function useRevokedCredentials() {
  return useQuery<RevocationEntry[]>({
    queryKey: ['verification', 'revocations'],
    queryFn: () => getRevocationsApi().listRevoked(),
    refetchInterval: 30_000,
  })
}

export function useRevokeCredential() {
  const qc = useQueryClient()
  return useMutation<void, Error, RevokeCredentialRequest>({
    mutationFn: (req) =>
      getAdminRevocationsApi().revokeCredential({ revokeCredentialRequest: req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['verification', 'revocations'] }),
  })
}

export function useSuspendCredential() {
  const qc = useQueryClient()
  return useMutation<void, Error, RevokeCredentialRequest>({
    mutationFn: (req) =>
      getAdminRevocationsApi().suspendCredential({ revokeCredentialRequest: req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['verification', 'revocations'] }),
  })
}

export function useReactivateCredential() {
  const qc = useQueryClient()
  return useMutation<void, Error, ReactivateCredentialRequest>({
    mutationFn: (req) =>
      getAdminRevocationsApi().reactivateCredential({ reactivateCredentialRequest: req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['verification', 'revocations'] }),
  })
}

export function useCheckRevocation() {
  return useMutation<CheckRevocationResponse, Error, CheckRevocationRequest>({
    mutationFn: (req) => getRevocationsApi().checkRevocation({ checkRevocationRequest: req }),
  })
}

// ---------------------------------------------------------------------------
// Verify Token
// ---------------------------------------------------------------------------

export function useVerifyToken() {
  return useMutation<VerifyResponse, Error, { token: string; challenge: string }>({
    mutationFn: (req) => getVerificationApi().verifyToken({ verifyRequest: req }),
  })
}

// ---------------------------------------------------------------------------
// GDPR
// ---------------------------------------------------------------------------

export { getGdprApi }
