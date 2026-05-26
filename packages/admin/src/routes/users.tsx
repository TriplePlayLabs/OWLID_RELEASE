import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { UserCog, Plus, UserX } from 'lucide-react'
import { toast } from 'sonner'

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
import { Badge } from '@owlid/ui/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@owlid/ui/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@owlid/ui/components/ui/dialog'
import { openConfirmModal } from '@owlid/ui/modal'
import { useAdminUsers, useCreateAdminUser, useDeactivateAdminUser } from '~/hooks/use-admin'
import { useAuth } from '~/hooks/use-auth'
import { PageHeader } from '~/components/PageHeader'
import { StatusBadge } from '~/components/StatusBadge'
import { RelativeTime } from '~/components/RelativeTime'
import { TableSkeleton, TableError, TableEmpty } from '~/components/TableStates'

export const Route = createFileRoute('/users')({
  component: UsersPage,
})

const MIN_LEN = 12
const COLS = 5

function UsersPage() {
  const users = useAdminUsers()
  const deactivate = useDeactivateAdminUser()
  const { username: currentUser } = useAuth()

  async function handleDeactivate(id: string, username: string) {
    const ok = await openConfirmModal({
      title: 'Deactivate account',
      description: `"${username}" will lose dashboard access immediately. This cannot be undone from the UI.`,
      confirmLabel: 'Deactivate',
      variant: 'destructive',
    })
    if (ok !== 'confirmed') return
    deactivate.mutate(id, {
      onSuccess: () => toast.success('Account deactivated'),
      onError: (err) => toast.error(err.message),
    })
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin Users"
        description="Operator accounts that can sign in to this dashboard"
      >
        <CreateUserDialog />
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserCog className="h-5 w-5" /> Accounts
          </CardTitle>
          <CardDescription>
            {users.data ? `${users.data.length} accounts` : 'Loading…'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Username</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last Login</TableHead>
                <TableHead className="w-[50px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.isLoading && <TableSkeleton cols={COLS} />}
              {users.isError && (
                <TableError
                  colSpan={COLS}
                  message={users.error?.message ?? 'Failed to load admin users'}
                  onRetry={() => users.refetch()}
                />
              )}
              {users.data?.length === 0 && (
                <TableEmpty
                  colSpan={COLS}
                  icon={<UserCog className="h-6 w-6" />}
                  title="No admin users"
                />
              )}
              {users.data?.map((u) => {
                const isSelf = u.username === currentUser
                return (
                  <TableRow key={u.id} className={u.isActive ? '' : 'opacity-60'}>
                    <TableCell className="font-medium">
                      {u.username}
                      {isSelf && (
                        <Badge variant="secondary" className="ml-2 text-xs">
                          You
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={u.isActive ? 'active' : 'disabled'} />
                    </TableCell>
                    <TableCell className="text-sm">
                      <RelativeTime value={u.createdAt} />
                    </TableCell>
                    <TableCell className="text-sm">
                      {u.lastLoginAt ? (
                        <RelativeTime value={u.lastLoginAt} />
                      ) : (
                        <span className="text-muted-foreground">Never</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {u.isActive && !isSelf && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive"
                          onClick={() => handleDeactivate(u.id, u.username)}
                          disabled={deactivate.isPending}
                          aria-label={`Deactivate ${u.username}`}
                        >
                          <UserX className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function CreateUserDialog() {
  const create = useCreateAdminUser()
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  const passwordTooShort = password.length > 0 && password.length < MIN_LEN
  const mismatch = confirm.length > 0 && confirm !== password
  const canSubmit = username.trim().length > 0 && password.length >= MIN_LEN && confirm === password

  function reset() {
    setUsername('')
    setPassword('')
    setConfirm('')
  }

  function handleCreate() {
    if (!canSubmit) return
    create.mutate(
      { username: username.trim(), password },
      {
        onSuccess: () => {
          toast.success('Admin account created')
          reset()
          setOpen(false)
        },
        onError: (err) => toast.error(err.message),
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" /> New Account
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Admin Account</DialogTitle>
          <DialogDescription>
            The new account holds the full operator surface. Share the password securely — it is not
            recoverable.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="new-username">Username</Label>
            <Input
              id="new-username"
              autoComplete="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-password">Password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={passwordTooShort}
            />
            <p
              className={`text-xs ${passwordTooShort ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              At least {MIN_LEN} characters.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="confirm-password">Confirm Password</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={mismatch}
            />
            {mismatch && <p className="text-xs text-destructive">Passwords do not match.</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!canSubmit || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create Account'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
