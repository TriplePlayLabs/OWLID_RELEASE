import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

interface AuthState {
  isAuthenticated: boolean
  username: string | null
  token: string | null
  login: (token: string, username: string) => void
  logout: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const isBrowser = typeof window !== 'undefined'
  const [token, setToken] = useState<string | null>(() =>
    isBrowser ? localStorage.getItem('admin_token') : null,
  )
  const [username, setUsername] = useState<string | null>(() =>
    isBrowser ? localStorage.getItem('admin_username') : null,
  )

  const login = useCallback((newToken: string, newUsername: string) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('admin_token', newToken)
      localStorage.setItem('admin_username', newUsername)
    }
    setToken(newToken)
    setUsername(newUsername)
  }, [])

  const logout = useCallback(() => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('admin_token')
      localStorage.removeItem('admin_username')
    }
    setToken(null)
    setUsername(null)
  }, [])

  return (
    <AuthContext.Provider value={{ isAuthenticated: !!token, username, token, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
