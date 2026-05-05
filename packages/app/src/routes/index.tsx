import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { storage } from '@owlid/sdk'

export const Route = createFileRoute('/')({
  component: IndexRedirect,
})

function IndexRedirect() {
  const navigate = useNavigate()
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    async function checkAndRedirect() {
      const hasIdentity = await storage.hasStoredIdentity()
      const stored = await storage.loadStoredIdentity()

      if (hasIdentity) {
        // Full identity exists - need to unlock
        navigate({ to: '/locked', replace: true })
      } else if (stored.credentialId) {
        // Has passkey but no identity - go to login
        navigate({ to: '/login', replace: true })
      } else {
        // New user - go to register
        navigate({ to: '/register', replace: true })
      }
      setIsLoading(false)
    }
    checkAndRedirect()
  }, [navigate])

  if (isLoading) return null
  return null
}
