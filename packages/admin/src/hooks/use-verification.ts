import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getVerificationApi,
  getIssuersApi,
  getRevocationsApi,
  getMonitoringApi,
  getGdprApi,
} from '~/lib/api'
import type {
  TrustedIssuerInfo,
  AddTrustedIssuerRequest,
  AddTrustedIssuerResponse,
  RevokeCredentialRequest,
  ReactivateCredentialRequest,
  CheckRevocationRequest,
  CheckRevocationResponse,
  VerifyResponse,
} from '@owlid/sdk'

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export function useVerificationHealth() {
  return useQuery({
    queryKey: ['verification', 'health'],
    queryFn: () => getMonitoringApi().health(),
    refetchInterval: 30_000,
  })
}

// ---------------------------------------------------------------------------
// Metrics — getMetrics() returns void in the generated client, so use raw
// ---------------------------------------------------------------------------

export interface VerificationMetrics {
  totalVerifications: number
  successfulVerifications: number
  failedVerifications: number
  successRate: number
}

export function useMetrics() {
  return useQuery<VerificationMetrics>({
    queryKey: ['verification', 'metrics'],
    queryFn: async () => {
      const resp = await getMonitoringApi().getMetricsRaw()
      return (await resp.raw.json()) as VerificationMetrics
    },
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
  })
}

export function useAddTrustedIssuer() {
  const qc = useQueryClient()
  return useMutation<AddTrustedIssuerResponse, Error, AddTrustedIssuerRequest>({
    mutationFn: (req) => getIssuersApi().addTrustedIssuer({ addTrustedIssuerRequest: req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['verification', 'issuers'] }),
  })
}

// ---------------------------------------------------------------------------
// Revocations
// ---------------------------------------------------------------------------

export interface RevocationEntry {
  credentialId: string
  status: string
  reason?: string
  revokedAt: string
}

export function useRevokedCredentials() {
  return useQuery<RevocationEntry[]>({
    queryKey: ['verification', 'revocations'],
    queryFn: async () => {
      // listRevoked() returns void in the generated client — use raw
      const resp = await getRevocationsApi().listRevokedRaw()
      return (await resp.raw.json()) as RevocationEntry[]
    },
  })
}

export function useRevokeCredential() {
  const qc = useQueryClient()
  return useMutation<void, Error, RevokeCredentialRequest>({
    mutationFn: (req) => getRevocationsApi().revokeCredential({ revokeCredentialRequest: req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['verification', 'revocations'] }),
  })
}

export function useSuspendCredential() {
  const qc = useQueryClient()
  return useMutation<void, Error, RevokeCredentialRequest>({
    mutationFn: (req) => getRevocationsApi().suspendCredential({ revokeCredentialRequest: req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['verification', 'revocations'] }),
  })
}

export function useReactivateCredential() {
  const qc = useQueryClient()
  return useMutation<void, Error, ReactivateCredentialRequest>({
    mutationFn: (req) =>
      getRevocationsApi().reactivateCredential({ reactivateCredentialRequest: req }),
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
