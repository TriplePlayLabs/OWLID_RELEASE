/**
 * Proofs Hook
 *
 * Manages proof selection and generation using the OwlID SDK.
 * Uses ZK predicate proofs for all proof types (age, nationality, KYC, residency).
 * WebAuthn provides hardware-backed P-256 signatures with biometric auth.
 */

import { useState, useCallback, useMemo, useEffect } from 'react'
import {
  Credential,
  PreparedToken,
  Token as NativeToken,
  type ProofRequest,
  type WebAuthnSignatureData,
  type VerifiedClaims,
  proofStorage,
  type StoredProof,
} from '@owlid/sdk'
import type { GeneratedProof } from '~/types/proof'
import { getAvailableProofs, getProofPredicates } from '~/utils/proof-utils'
import { storage } from '@owlid/sdk'
import { useWebAuthn } from './use-webauthn'

/**
 * Prepare a token with ZK predicates for WebAuthn signing (Phase 1)
 */
function prepareTokenForWebAuthn(
  credentialJson: string,
  predicates: ProofRequest['predicates'],
  disclose: string[],
  challenge: string,
  ttlSeconds: number = 3600,
) {
  const proofDoc = Credential.fromJson(credentialJson)

  const proofRequest: ProofRequest = {
    disclose,
    predicates,
    trustedIssuers: [],
    challenge,
  }

  const preparedToken = proofDoc.prepare(proofRequest, ttlSeconds)

  return {
    preparedToken,
    webauthnChallenge: preparedToken.challenge(),
  }
}

/**
 * Finalize a token with WebAuthn signature (Phase 2)
 */
function finalizeTokenWithWebAuthn(
  preparedTokenJson: string,
  webauthnSig: WebAuthnSignatureData,
  credentialPublicKey: string,
) {
  const preparedToken = PreparedToken.fromJson(preparedTokenJson)
  const token = NativeToken.finalizeWebauthn(preparedToken, webauthnSig, credentialPublicKey)

  return {
    token,
    tokenJson: token.toJson(),
  }
}

/**
 * Convert GeneratedProof to StoredProof (for IndexedDB)
 */
function toStoredProof(proof: GeneratedProof): StoredProof {
  return {
    id: proof.id,
    name: proof.name,
    claim: proof.claim,
    result: proof.result,
    tokenJson: JSON.stringify(proof.token),
    createdAt: new Date().toISOString(),
  }
}

/**
 * Convert StoredProof to GeneratedProof (from IndexedDB)
 * Requires available proofs to get icon and other display properties
 */
function fromStoredProof(
  stored: StoredProof,
  availableProofs: ReturnType<typeof getAvailableProofs>,
): GeneratedProof | null {
  const baseProof = availableProofs.find((p) => p.id === stored.id)
  if (!baseProof) return null

  const token = JSON.parse(stored.tokenJson)
  // Regenerate compact QR data from stored JSON
  let qrData: string
  try {
    const nativeToken = NativeToken.fromJson(stored.tokenJson)
    qrData = nativeToken.toCompact()
  } catch {
    qrData = stored.tokenJson
  }
  return {
    ...baseProof,
    name: stored.name,
    payload: token,
    qrData,
    token,
  }
}

export function useProofs() {
  const [selectedProofs, setSelectedProofs] = useState<Set<string>>(new Set())
  const [generatedProofs, setGeneratedProofs] = useState<GeneratedProof[]>([])
  const [viewingProof, setViewingProof] = useState<GeneratedProof | null>(null)
  const [isProofModalOpen, setIsProofModalOpen] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [verifiedClaims, setVerifiedClaims] = useState<VerifiedClaims | null>(null)

  // WebAuthn hook for hardware-backed signing
  const { signForToken } = useWebAuthn()

  // Load verified claims from storage (backend is source of truth)
  useEffect(() => {
    storage.getStoredClaims().then(setVerifiedClaims)
  }, [])

  // All proof values come directly from backend - no frontend computation
  const availableProofs = useMemo(() => getAvailableProofs(verifiedClaims), [verifiedClaims])

  // Load persisted proofs from IndexedDB on mount
  useEffect(() => {
    if (availableProofs.length === 0) return

    proofStorage
      .getAllProofs()
      .then((storedProofs) => {
        const restored = storedProofs
          .map((sp) => fromStoredProof(sp, availableProofs))
          .filter((p): p is GeneratedProof => p !== null)

        if (restored.length > 0) {
          setGeneratedProofs(restored)
        }
      })
      .catch((err) => {
        console.warn('[Proofs] Failed to load stored proofs:', err)
      })
  }, [availableProofs])

  const toggleProofSelection = useCallback((proofId: string) => {
    setSelectedProofs((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(proofId)) {
        newSet.delete(proofId)
      } else {
        newSet.add(proofId)
      }
      return newSet
    })
  }, [])

  /**
   * Create proofs for selected items using WebAuthn hardware-backed signatures.
   * All proofs use ZK predicates — no legacy disclosure path.
   *
   * @param challenge - Server-generated challenge from the verifier.
   *                    The holder must scan the verifier's challenge QR first.
   */
  const createProofs = useCallback(
    async (challenge: string) => {
      if (isGenerating) return // Prevent concurrent proof generation

      if (!challenge) {
        console.error('Challenge is required. Scan the verifier challenge QR first.')
        return
      }

      const selected = availableProofs.filter((p) => selectedProofs.has(p.id))

      if (selected.length === 0) {
        return
      }

      setIsGenerating(true)

      try {
        const credentialData = await storage.loadCredentialData()
        const webauthnCred = await storage.loadWebAuthnCredential()

        if (!credentialData) {
          console.error('No credential data found. Complete identity verification first.')
          return
        }

        if (!webauthnCred) {
          console.error('No WebAuthn credential found. Re-register with biometric authentication.')
          return
        }

        const generated: GeneratedProof[] = []
        const credentialJson = JSON.stringify(credentialData.credential)

        for (const proof of selected) {
          const predicates = getProofPredicates(proof.id)

          // Phase 1: Prepare token with ZK predicates
          const prepared = prepareTokenForWebAuthn(
            credentialJson,
            predicates,
            [], // No attributes disclosed — ZK proof handles everything
            challenge,
            3600,
          )

          // Phase 2: Sign with WebAuthn (triggers biometric prompt)
          const webauthnSig = await signForToken(
            webauthnCred.credentialId,
            prepared.webauthnChallenge,
          )

          // Phase 3: Finalize token with WebAuthn signature
          const result = finalizeTokenWithWebAuthn(
            prepared.preparedToken.toJson(),
            {
              authenticatorData: webauthnSig.authenticatorData,
              clientDataJson: webauthnSig.clientDataJSON,
              signature: webauthnSig.signature,
            },
            webauthnCred.publicKey,
          )

          // Parse token for display/storage, use compact format for QR
          const token = JSON.parse(result.tokenJson)
          const compactData = result.token.toCompact()

          generated.push({
            ...proof,
            name: proof.claim,
            payload: token,
            qrData: compactData,
            token,
          } as GeneratedProof)
        }

        // Save to IndexedDB for persistence
        const toStore = generated.map(toStoredProof)
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
    [availableProofs, selectedProofs, signForToken, isGenerating],
  )

  const closeProofModal = useCallback(() => {
    setIsProofModalOpen(false)
    setSelectedProofs(new Set())
  }, [])

  const openProofModal = useCallback(() => {
    setIsProofModalOpen(true)
  }, [])

  const shareProof = useCallback(async (proof: GeneratedProof): Promise<boolean> => {
    // Check if we're on mobile (native share works well there)
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

    // Only use native share on mobile - desktop share dialogs are buggy
    if (isMobile && navigator.share) {
      try {
        await navigator.share({
          title: `OwlID Proof: ${proof.claim}`,
          text: proof.qrData,
        })
        return true
      } catch {
        // Share cancelled or failed - fall through to clipboard
      }
    }

    // Use clipboard on desktop (more reliable)
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
