import { useState } from 'react'
import { Shield, Loader2, AlertCircle } from 'lucide-react'
import { useAdminLogin } from '~/hooks/use-admin'
import { useAuth } from '~/contexts/auth-context'

export function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const loginMutation = useAdminLogin()
  const { login } = useAuth()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const result = await loginMutation.mutateAsync({ username, password })
      login(result.token, result.username)
    } catch {
      // error handled by mutation state
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 p-8">
        <div className="text-center space-y-2">
          <Shield className="w-12 h-12 mx-auto text-primary" />
          <h1 className="text-2xl font-bold">OwlID Admin</h1>
          <p className="text-sm text-muted-foreground">
            Sign in to manage the verification service
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {loginMutation.isError && (
            <div className="flex items-center gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20 text-sm text-destructive">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{loginMutation.error?.message || 'Login failed'}</span>
            </div>
          )}

          <div className="space-y-2">
            <label htmlFor="username" className="text-sm font-medium">
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              required
              autoFocus
              className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              required
              className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <button
            type="submit"
            disabled={loginMutation.isPending || !username || !password}
            className="w-full py-2 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loginMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Signing in...
              </>
            ) : (
              'Sign in'
            )}
          </button>
        </form>

        <p className="text-xs text-center text-muted-foreground">
          Default credentials: admin / admin
        </p>
      </div>
    </div>
  )
}
