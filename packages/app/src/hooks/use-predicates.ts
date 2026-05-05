/**
 * Predicate + circuit-dataset registry hooks.
 *
 * The issuer service is the canonical source for which predicates exist and
 * what each one maps to (attribute, op, JSON-encoded wire value). UI
 * surfaces — proof picker, presentation consent — read from these hooks
 * instead of hard-coding ids and country lists.
 */

import { useQuery } from '@tanstack/react-query'
import type { PredicateInfo, CircuitDataset, CircuitDatasetInfo } from '@owlid/sdk/verifier'
import { registryApi } from '~/lib/api'

export const predicateQueryKeys = {
  all: ['predicates'] as const,
  list: () => [...predicateQueryKeys.all, 'list'] as const,
  circuitData: () => ['circuit-data'] as const,
  circuitDataset: (name: string) => ['circuit-data', name] as const,
}

/** Every predicate the system can prove. Cached forever (registry is static). */
export function usePredicates() {
  return useQuery<PredicateInfo[], Error>({
    queryKey: predicateQueryKeys.list(),
    queryFn: () => registryApi.listPredicates(),
    staleTime: Infinity,
    gcTime: Infinity,
  })
}

/** Summaries of every registered circuit dataset. */
export function useCircuitData() {
  return useQuery<CircuitDatasetInfo[], Error>({
    queryKey: predicateQueryKeys.circuitData(),
    queryFn: () => registryApi.listCircuitData(),
    staleTime: Infinity,
    gcTime: Infinity,
  })
}

/** Full leaf list of a named circuit dataset. */
export function useCircuitDataset(name: string | undefined) {
  return useQuery<CircuitDataset, Error>({
    queryKey: predicateQueryKeys.circuitDataset(name ?? ''),
    queryFn: () => registryApi.getCircuitDataset({ name: name as string }),
    enabled: !!name,
    staleTime: Infinity,
    gcTime: Infinity,
  })
}
