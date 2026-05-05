import { useState, useCallback, useEffect } from 'react'
import type { IdentityData } from '@owlid/sdk'
import type { Bank } from '~/types/identity'
import { MOCK_IDENTITY } from '~/constants/banks'
import { storage } from '@owlid/sdk'

export type DemoStep = 'register' | 'login' | 'create-identity' | 'locked' | 'passport'

interface UseIdentityOptions {
  onLog?: (type: 'info' | 'success' | 'error' | 'system', message: string) => void
}

export function useIdentity(options: UseIdentityOptions = {}) {
  const { onLog } = options

  const [activeStep, setActiveStep] = useState<DemoStep>('register')
  const [username, setUsername] = useState('')
  const [credentialId, setCredentialId] = useState<string | null>(null)
  const [isRegistered, setIsRegistered] = useState(false)
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [isIdentityCreated, setIsIdentityCreated] = useState(false)
  const [identityData, setIdentityData] = useState<IdentityData | null>(null)
  const [selectedBank, setSelectedBank] = useState<Bank | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  // Check for stored identity on mount
  useEffect(() => {
    async function checkStoredIdentity() {
      const stored = await storage.loadStoredIdentity()
      const hasCredential = await storage.hasStoredCredential()

      if (stored.encryptedBlob && stored.credentialId && stored.username) {
        setUsername(stored.username)
        setCredentialId(stored.credentialId)
        setIsRegistered(true)

        // If we have a stored credential, identity was already created
        if (hasCredential) {
          setIsIdentityCreated(true)
          onLog?.('system', 'Stored credential found. Identity locked.')
        }

        setActiveStep('locked')
        onLog?.('system', 'Encrypted identity blob found in local storage.')
        onLog?.('info', 'Identity is locked. WebAuthn required to unlock.')
      } else if (stored.credentialId && stored.username) {
        // User registered but hasn't created identity yet
        setUsername(stored.username)
        setCredentialId(stored.credentialId)
        setIsRegistered(true)
        setActiveStep('login')
        onLog?.('system', 'Passkey found. Please login to continue.')
      }
    }
    checkStoredIdentity()
  }, [onLog])

  const completeRegistration = useCallback(async (newCredentialId: string, newUsername: string) => {
    setCredentialId(newCredentialId)
    await storage.saveIdentity(newCredentialId, newUsername)
    setIsRegistered(true)
    setActiveStep('login')
  }, [])

  const completeLogin = useCallback(() => {
    setIsLoggedIn(true)
    setActiveStep('create-identity')
  }, [])

  const completeIdentityCreation = useCallback(async (data: IdentityData) => {
    setIdentityData(data)
    await storage.saveEncryptedIdentity(data)
    setIsIdentityCreated(true)
  }, [])

  /**
   * Legacy: Fetch identity from bank (mock for demo)
   */
  const fetchIdentityFromBank = useCallback(
    async (bank: Bank): Promise<IdentityData> => {
      onLog?.('system', 'Connecting to OwlID Demo Bank Identity Provider...')

      // Simulate bank API call
      await new Promise((resolve) => setTimeout(resolve, 1500))

      onLog?.('success', `Identity attributes retrieved from ${bank.name}`)
      return MOCK_IDENTITY
    },
    [onLog],
  )

  const unlockIdentity = useCallback(
    async (encryptedBlob: string) => {
      const decrypted = storage.decryptIdentity(encryptedBlob)
      setIdentityData(decrypted)
      setIsRegistered(true)
      setIsLoggedIn(true)
      onLog?.('success', 'Identity Decrypted Successfully')

      // Check if credential already exists - if so, go to passport
      const credentialData = await storage.loadCredentialData()
      if (credentialData) {
        setIsIdentityCreated(true)
        setActiveStep('passport')
        onLog?.('info', 'Credential loaded from storage')
      } else {
        setActiveStep('create-identity')
      }

      return decrypted
    },
    [onLog],
  )

  const resetDemo = useCallback(async () => {
    await storage.clearAll()
    window.location.reload()
  }, [])

  return {
    // State
    activeStep,
    username,
    credentialId,
    isRegistered,
    isLoggedIn,
    isIdentityCreated,
    identityData,
    selectedBank,
    isLoading,

    // Setters
    setActiveStep,
    setUsername,
    setCredentialId,
    setSelectedBank,
    setIsLoading,
    setIdentityData,

    // Actions
    completeRegistration,
    completeLogin,
    completeIdentityCreation,
    fetchIdentityFromBank,
    unlockIdentity,
    resetDemo,
  }
}
