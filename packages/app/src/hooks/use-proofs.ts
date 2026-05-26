/**
 * Proofs Hook
 *
 * Manages proof selection and generation using the OwlID SDK. A "proof" is a
 * standard SD-JWT VC presentation: the issuer pre-asserts predicate claims
 * (`age_over_18`, …); the holder selectively discloses them and binds the
 * presentation to the verifier with a KB-JWT.
 */

import { useState, useCallback, useMemo, useEffect } from 'react'
import {
  presentSdJwtVc,
  proofStorage,
  storage,
  unwrapHolderKey,
  type StoredProof,
  type VerifiedClaims,
} from '@owlid/sdk'
import type { GeneratedProof } from '~/types/proof'
import { getAvailableProofs, disclosuresForPredicate } from '~/utils/proof-utils'
import { usePredicates } from './use-predicates'

function fromStoredProof(
  stored: StoredProof,
  availableProofs: ReturnType<typeof getAvailableProofs>,
): GeneratedProof | null {
  const baseProof = availableProofs.find((p) => p.id === stored.id)
  if (!baseProof) return null
  return {
    ...baseProof,
    name: stored.name,
    payload: stored.presentation,
    qrData: stored.presentation,
    token: stored.presentation,
  } as GeneratedProof
}

export function useProofs() {
  const [selectedProofs, setSelectedProofs] = useState<Set<string>>(new Set())
  const [generatedProofs, setGeneratedProofs] = useState<GeneratedProof[]>([])
  const [viewingProof, setViewingProof] = useState<GeneratedProof | null>(null)
  const [isProofModalOpen, setIsProofModalOpen] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [verifiedClaims, setVerifiedClaims] = useState<VerifiedClaims | null>(null)

  const { data: registry } = usePredicates()

  useEffect(() => {
    storage.listCredentials().then((list) => setVerifiedClaims(list[0]?.verifiedClaims ?? null))
  }, [])

  // Filtered by registry × claim shape (issuer-asserted claims).
  const availableProofs = useMemo(
    () => getAvailableProofs(verifiedClaims, registry, []),
    [verifiedClaims, registry],
  )

  // Restore persisted presentations from IndexedDB.
  useEffect(() => {
    if (availableProofs.length === 0) return
    proofStorage
      .getAllProofs()
      .then((storedProofs) => {
        const restored = storedProofs
          .map((sp) => fromStoredProof(sp, availableProofs))
          .filter((p): p is GeneratedProof => p !== null)
        if (restored.length > 0) setGeneratedProofs(restored)
      })
      .catch((err) => console.warn('[Proofs] Failed to load stored proofs:', err))
  }, [availableProofs])

  const toggleProofSelection = useCallback((proofId: string) => {
    setSelectedProofs((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(proofId)) newSet.delete(proofId)
      else newSet.add(proofId)
      return newSet
    })
  }, [])

  const closeProofModal = useCallback(() => {
    setIsProofModalOpen(false)
    setSelectedProofs(new Set())
  }, [])

  /**
   * Build SD-JWT VC presentations for the selected predicates, each bound to
   * the verifier challenge via a KB-JWT.
   *
   * @param challenge - Verifier nonce (scan the verifier challenge QR first).
   */
  const createProofs = useCallback(
    async (challenge: string) => {
      if (isGenerating) return
      if (!challenge) {
        console.error('Challenge is required. Scan the verifier challenge QR first.')
        return
      }
      const selected = availableProofs.filter((p) => selectedProofs.has(p.id))
      if (selected.length === 0) return

      setIsGenerating(true)
      try {
        const list = await storage.listCredentials()
        const credential = list[0]
        if (!credential) {
          console.error('No credential. Complete identity verification first.')
          return
        }
        const wrapped = await storage.getCredentialKeyWrapped(credential.credentialId)
        if (!wrapped) {
          console.error('No holder key found for this credential.')
          return
        }
        const passkey = await storage.loadWebAuthnCredential()
        if (!passkey) {
          console.error('No passkey found — re-register required.')
          return
        }
        // Passkey-gated decrypt of the per-cred holder key (UV prompt).
        const holderKeyHex = await unwrapHolderKey(passkey.credentialId, wrapped)

        const sdJwtVc = credential.sdJwtVc
        const generated: GeneratedProof[] = []

        for (const proof of selected) {
          const disclose = disclosuresForPredicate(proof.id)
          const presentation = presentSdJwtVc(sdJwtVc, holderKeyHex, disclose, {
            aud: challenge,
            nonce: challenge,
          })
          generated.push({
            ...proof,
            name: proof.claim,
            payload: presentation,
            qrData: presentation,
            token: presentation,
          } as GeneratedProof)
        }

        const toStore: StoredProof[] = generated.map((g) => ({
          id: g.id,
          name: g.name,
          claim: g.claim,
          result: g.result,
          presentation: g.qrData,
          createdAt: new Date().toISOString(),
        }))
        await proofStorage.saveProofs(toStore)

        setGeneratedProofs((prev) => [
          ...prev,
          ...generated.filter((g) => !prev.some((p) => p.id === g.id)),
        ])
      } catch (error) {
        console.error('[Proofs] Failed to create proofs:', error)
      } finally {
        setIsGenerating(false)
        closeProofModal()
      }
    },
    [availableProofs, selectedProofs, isGenerating, closeProofModal],
  )

  const openProofModal = useCallback(() => setIsProofModalOpen(true), [])

  const shareProof = useCallback(async (proof: GeneratedProof): Promise<boolean> => {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    if (isMobile && navigator.share) {
      try {
        await navigator.share({ title: `OwlID Proof: ${proof.claim}`, text: proof.qrData })
        return true
      } catch {
        // fall through to clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(proof.qrData)
      return true
    } catch {
      console.warn('Clipboard API not available')
      return false
    }
  }, [])

  const resetProofs = useCallback(async () => {
    await proofStorage.clearAllProofs()
    setGeneratedProofs([])
    setSelectedProofs(new Set())
    setViewingProof(null)
  }, [])

  return {
    availableProofs,
    selectedProofs,
    generatedProofs,
    viewingProof,
    isProofModalOpen,
    isGenerating,
    toggleProofSelection,
    createProofs,
    openProofModal,
    closeProofModal,
    setViewingProof,
    shareProof,
    resetProofs,
  }
}
