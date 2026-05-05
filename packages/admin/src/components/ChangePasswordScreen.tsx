import { useState } from 'react'
import { ShieldAlert, Loader2, LogOut } from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@owlid/ui/components/ui/card'
import { Button } from '@owlid/ui/components/ui/button'
import { Input } from '@owlid/ui/components/ui/input'
import { Label } from '@owlid/ui/components/ui/label'
import { useAuth } from '~/hooks/use-auth'

const MIN_LEN = 12

/**
 * Forced password-change interstitial. Shown by AuthGate when the
 * operator just authenticated with the built-in default credentials.
 *
 * The screen blocks the rest of the dashboard until the new password is
 * accepted by the backend. Cancel is intentionally a logout — leaving
 * the gate without rotating drops the session entirely.
 */
export function ChangePasswordScreen() {
  const { changePasswordMutation, logoutMutation, username } = useAuth()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const submitting = changePasswordMutation.isPending

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLocalError(null)
    if (newPassword !== confirmPassword) {
      setLocalError('New password and confirmation must match.')
      return
    }
    if (newPassword.length < MIN_LEN) {
      setLocalError(`New password must be at least ${MIN_LEN} characters.`)
      return
    }
    if (newPassword === 'admin') {
      setLocalError('New password may not be the built-in default.')
      return
    }
    if (newPassword === currentPassword) {
      setLocalError('New password must differ from the current password.')
      return
    }
    changePasswordMutation.mutate({ currentPassword, newPassword })
  }

  const serverError =
    changePasswordMutation.error instanceof Error ? changePasswordMutation.error.message : null

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2">
          <div className="mx-auto w-10 h-10 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
            <ShieldAlert className="w-5 h-5 text-amber-400" />
          </div>
          <CardTitle className="text-center">Change default password</CardTitle>
          <CardDescription className="text-center">
            You are signed in as <span className="font-mono">{username ?? 'admin'}</span> using the
            built-in default credentials. Pick a new password before continuing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="current">Current password</Label>
              <Input
                id="current"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                disabled={submitting}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new">New password</Label>
              <Input
                id="new"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={submitting}
                minLength={MIN_LEN}
                required
              />
              <p className="text-xs text-muted-foreground">
                At least {MIN_LEN} characters. Must differ from the default and from the current
                password.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm">Confirm new password</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={submitting}
                minLength={MIN_LEN}
                required
              />
            </div>

            {(localError || serverError) && (
              <p className="text-sm text-destructive">{localError ?? serverError}</p>
            )}

            <div className="flex items-center justify-between gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => logoutMutation.mutate()}
                disabled={submitting}
              >
                <LogOut className="w-4 h-4 mr-2" />
                Sign out
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Change password
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
