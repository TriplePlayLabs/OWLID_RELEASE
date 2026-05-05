import type { LucideIcon } from 'lucide-react'

export interface DerivedProof {
  id: string
  title: string
  claim: string
  result: boolean
  icon: LucideIcon
  sourceField: string
  description: string
}

export interface VerifiablePresentation {
  '@context': string
  type: 'VerifiablePresentation'
  holder: string
  proof: {
    type: string
    created: string
    proofPurpose: string
    verificationMethod: string
  }
  claim: {
    type: 'DerivedProof'
    attribute: string
    result: boolean
    issuedAt: string
  }
}

export interface GeneratedProof extends DerivedProof {
  name: string
  payload: VerifiablePresentation | unknown | null
  qrData: string
  /** Cryptographic proof token from API */
  token?: unknown
}
