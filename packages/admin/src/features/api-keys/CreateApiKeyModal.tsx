import { useState } from 'react'
import { AlertTriangle, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Environment, KeyType, type CreateApiKeyResponse } from '@owlid/admin-client'
import { Button } from '@owlid/ui/components/ui/button'
import { Checkbox } from '@owlid/ui/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@owlid/ui/components/ui/dialog'
import { Input } from '@owlid/ui/components/ui/input'
import { Label } from '@owlid/ui/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@owlid/ui/components/ui/select'
import { Textarea } from '@owlid/ui/components/ui/textarea'
import { registerModal, type ModalRenderProps } from '@owlid/ui/modal'
import { useCreateApiKey } from '~/hooks/use-admin'

// Scopes the verification service actually enforces (see `require_permission`
// in the Rust router). `verify` covers the read + verify surface; `admin`
// gates issuer + revocation management; `gdpr` gates erasure. There is no
// finer-grained `manage_*` scope — issuer/revocation routes require `admin`.
const AVAILABLE_PERMISSIONS = [
  {
    id: 'verify',
    label: 'Verify',
    description: 'Verify presentations; read trusted issuers and revocation status',
  },
  {
    id: 'admin',
    label: 'Admin',
    description: 'Manage trusted issuers, revocations and service metrics',
  },
  { id: 'gdpr', label: 'GDPR Erasure', description: 'Right-to-be-forgotten endpoint' },
]

const KEY_TYPE_LABEL: Record<KeyType, string> = {
  [KeyType.pk]: 'Publishable',
  [KeyType.sk]: 'Secret',
}

const ENV_LABEL: Record<Environment, string> = {
  [Environment.live]: 'Live',
  [Environment.test]: 'Test',
}

function copyText(text: string, label = 'Copied to clipboard') {
  navigator.clipboard.writeText(text)
  toast.success(label)
}

function CreateApiKeyModal({
  isOpen,
  close,
}: ModalRenderProps<Record<string, never>, CreateApiKeyResponse | undefined>) {
  const createApiKey = useCreateApiKey()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [keyType, setKeyType] = useState<KeyType>(KeyType.sk)
  const [environment, setEnvironment] = useState<Environment>(Environment.live)
  const [permissions, setPermissions] = useState<string[]>(['verify'])
  const [createdKey, setCreatedKey] = useState<CreateApiKeyResponse | null>(null)

  const isPublishable = keyType === KeyType.pk
  const allowedPermissions = isPublishable
    ? AVAILABLE_PERMISSIONS.filter((p) => p.id === 'verify')
    : AVAILABLE_PERMISSIONS

  function selectKeyType(next: KeyType) {
    setKeyType(next)
    if (next === KeyType.pk) setPermissions(['verify'])
  }

  function togglePermission(perm: string) {
    if (isPublishable && perm !== 'verify') return
    setPermissions((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm],
    )
  }

  function handleCreate() {
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    if (permissions.length === 0) {
      toast.error('Select at least one permission')
      return
    }
    createApiKey.mutate(
      {
        name: name.trim(),
        description: description.trim() || undefined,
        permissions,
        keyType,
        environment,
      },
      {
        onSuccess: (data) => {
          setCreatedKey(data)
          toast.success('API key created')
        },
        onError: (err) => toast.error(err.message),
      },
    )
  }

  function handleDone() {
    close(createdKey ?? undefined)
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleDone()}>
      <DialogContent className="sm:max-w-md">
        {createdKey ? (
          <>
            <DialogHeader>
              <DialogTitle>API Key Created</DialogTitle>
              <DialogDescription>
                This is the only time the full key will be shown. Copy it now.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="flex items-center gap-2 p-3 rounded-md bg-amber-500/10 border border-amber-500/20 text-sm text-amber-500">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>Save this key now — it cannot be retrieved later.</span>
              </div>
              <div className="grid gap-2">
                <Label className="text-xs">Full key</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs bg-muted px-3 py-2 rounded break-all font-mono select-all">
                    {createdKey.key}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => copyText(createdKey.key, 'API key copied')}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
                <div>
                  <Label className="text-xs uppercase">Type</Label>
                  <p className="mt-1">{KEY_TYPE_LABEL[createdKey.keyType]}</p>
                </div>
                <div>
                  <Label className="text-xs uppercase">Environment</Label>
                  <p className="mt-1">{ENV_LABEL[createdKey.environment]}</p>
                </div>
                <div className="col-span-2">
                  <Label className="text-xs uppercase">Preview</Label>
                  <code className="mt-1 block font-mono text-xs">{createdKey.keyPreview}</code>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleDone}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create API Key</DialogTitle>
              <DialogDescription>
                Mint a new key. Publishable (`pk_`) keys are browser-safe and limited to the
                `verify` scope; secret (`sk_`) keys are server-only and may carry any scope.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>Type</Label>
                  <Select value={keyType} onValueChange={(v) => selectKeyType(v as KeyType)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={KeyType.sk}>Secret (sk_)</SelectItem>
                      <SelectItem value={KeyType.pk}>Publishable (pk_)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label>Environment</Label>
                  <Select
                    value={environment}
                    onValueChange={(v) => setEnvironment(v as Environment)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={Environment.live}>Live</SelectItem>
                      <SelectItem value={Environment.test}>Test</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="key-name">Name</Label>
                <Input
                  id="key-name"
                  placeholder="e.g. Production Backend"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="key-description">Description</Label>
                <Textarea
                  id="key-description"
                  placeholder="Optional"
                  className="text-sm"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label>Permissions</Label>
                {isPublishable && (
                  <p className="text-xs text-muted-foreground">
                    Publishable keys are browser-safe and locked to the `verify` scope.
                  </p>
                )}
                <div className="space-y-3">
                  {allowedPermissions.map((perm) => (
                    <div key={perm.id} className="flex items-start gap-3">
                      <Checkbox
                        id={`perm-${perm.id}`}
                        checked={permissions.includes(perm.id)}
                        onCheckedChange={() => togglePermission(perm.id)}
                        disabled={isPublishable && perm.id !== 'verify'}
                      />
                      <div className="grid gap-0.5">
                        <label
                          htmlFor={`perm-${perm.id}`}
                          className="text-sm font-medium cursor-pointer"
                        >
                          {perm.label}
                        </label>
                        <p className="text-xs text-muted-foreground">{perm.description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => close(undefined)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={createApiKey.isPending}>
                {createApiKey.isPending ? 'Creating...' : 'Create Key'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export const { open: openCreateApiKeyModal } = registerModal<
  Record<string, never>,
  CreateApiKeyResponse | undefined
>(CreateApiKeyModal, {
  key: 'admin:api-keys:create',
  defaultArgs: {},
})
