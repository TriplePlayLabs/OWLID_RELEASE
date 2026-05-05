/**
 * Identity Context
 *
 * Minimal context for shared identity state across routes.
 * Only includes state that truly needs to be shared.
 */

import { createContext, useContext, type ReactNode } from 'react'
import type { IdentityData } from '@owlid/sdk'
import type { Bank } from '~/types/identity'
import { useIdentity, type DemoStep } from '~/hooks/use-identity'

interface IdentityContextValue {
  // Core identity state
  activeStep: DemoStep
  username: string
  credentialId: string | null
  isRegistered: boolean
  isLoggedIn: boolean
  isIdentityCreated: boolean
  identityData: IdentityData | null
  selectedBank: Bank | null
  isLoading: boolean

  // Core setters
  setUsername: (username: string) => void
  setSelectedBank: (bank: Bank | null) => void
  setIsLoading: (loading: boolean) => void
  setIdentityData: (data: IdentityData | null) => void
  setActiveStep: (step: DemoStep) => void

  // Core actions
  completeRegistration: (credentialId: string, username: string) => Promise<void>
  completeLogin: () => void
  completeIdentityCreation: (data: IdentityData) => Promise<void>
  unlockIdentity: (encryptedBlob: string) => Promise<IdentityData>
  resetDemo: () => Promise<void>
}

const IdentityContext = createContext<IdentityContextValue | null>(null)

export function IdentityProvider({ children }: { children: ReactNode }) {
  const identityHook = useIdentity()

  const value: IdentityContextValue = {
    // Core identity state
    activeStep: identityHook.activeStep,
    username: identityHook.username,
    credentialId: identityHook.credentialId,
    isRegistered: identityHook.isRegistered,
    isLoggedIn: identityHook.isLoggedIn,
    isIdentityCreated: identityHook.isIdentityCreated,
    identityData: identityHook.identityData,
    selectedBank: identityHook.selectedBank,
    isLoading: identityHook.isLoading,

    // Core setters
    setUsername: identityHook.setUsername,
    setSelectedBank: identityHook.setSelectedBank,
    setIsLoading: identityHook.setIsLoading,
    setIdentityData: identityHook.setIdentityData,
    setActiveStep: identityHook.setActiveStep,

    // Core actions
    completeRegistration: identityHook.completeRegistration,
    completeLogin: identityHook.completeLogin,
    completeIdentityCreation: identityHook.completeIdentityCreation,
    unlockIdentity: identityHook.unlockIdentity,
    resetDemo: identityHook.resetDemo,
  }

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>
}

export function useIdentityContext() {
  const context = useContext(IdentityContext)
  if (!context) {
    throw new Error('useIdentityContext must be used within an IdentityProvider')
  }
  return context
}
