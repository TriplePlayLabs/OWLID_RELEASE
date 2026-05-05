export interface WebAuthnCredential {
  id: string
  rawId: ArrayBuffer
  type: 'public-key'
}

export interface WebAuthnRegistrationResult {
  credentialId: string
  success: boolean
}

export interface WebAuthnAuthenticationResult {
  success: boolean
  assertion: PublicKeyCredential | null
}
