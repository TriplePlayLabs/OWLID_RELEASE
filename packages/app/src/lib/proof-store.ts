import { proofStorage, type StoredProof } from '@owlid/sdk'

export interface ProofRecordInput {
  predicateId: string
  name: string
  claim: string
  presentation: string
  result?: boolean
}

/** 'age_over_18' → 'Age over 18'. Leaves already-spaced labels alone. */
export function humanizePredicate(predicateId: string): string {
  const spaced = predicateId.replace(/[_-]+/g, ' ').trim()
  if (!spaced) return predicateId
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * Map a completed presentation into proof records, one per answered DCQL id.
 * Pure — no storage — so the mapping is unit-testable apart from IndexedDB.
 */
export function proofRecordsFromPresentation(
  used: Array<{ dcqlId: string }>,
  vpToken: Record<string, string[]>,
  opts: { verifierName?: string } = {},
): ProofRecordInput[] {
  const records: ProofRecordInput[] = []
  for (const { dcqlId } of used) {
    const presentation = vpToken[dcqlId]?.[0]
    if (!presentation) continue
    records.push({
      predicateId: dcqlId,
      claim: humanizePredicate(dcqlId),
      name: opts.verifierName?.trim() || humanizePredicate(dcqlId),
      presentation,
      result: true,
    })
  }
  return records
}

/** Persist proof records with a unique id + shared timestamp each. */
export async function recordProofs(inputs: ProofRecordInput[]): Promise<StoredProof[]> {
  if (inputs.length === 0) return []
  const createdAt = new Date().toISOString()
  const proofs: StoredProof[] = inputs.map((input) => ({
    id: crypto.randomUUID(),
    predicateId: input.predicateId,
    name: input.name,
    claim: input.claim,
    result: input.result ?? true,
    presentation: input.presentation,
    createdAt,
  }))
  await proofStorage.saveProofs(proofs)
  return proofs
}
