import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { CloudUpload, Cpu, Database, Fingerprint, Info, Loader2, Server } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@owlid/ui/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@owlid/ui/components/ui/card'
import { Input } from '@owlid/ui/components/ui/input'
import { Label } from '@owlid/ui/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@owlid/ui/components/ui/radio-group'
import { Separator } from '@owlid/ui/components/ui/separator'
import { Switch } from '@owlid/ui/components/ui/switch'
import { storage } from '@owlid/sdk'
import { BackLink } from '~/components/BackLink'
import {
  DEFAULT_SETTINGS,
  effectiveBackendLabel,
  getOperatorProofServerUrl,
  hasOperatorProofServer,
  loadSettings,
  normalizeProofServerUrl,
  pingProofServer,
  saveSettings,
  validateProofServerUrl,
  type AppSettings,
} from '~/lib/settings'

export const Route = createFileRoute('/_identity/settings')({
  component: SettingsPage,
})

const SETTINGS_QUERY_KEY = ['app', 'settings'] as const

function SettingsPage() {
  const qc = useQueryClient()

  const settings = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: loadSettings,
    // `initialData` keeps SSR markup happy (localStorage is undefined on
    // the server); `initialDataUpdatedAt: 0` marks it as stale so the
    // queryFn actually runs on client mount and reads the persisted
    // settings out of localStorage. Without that, staleTime=Infinity +
    // initialData would pin the cache to DEFAULT_SETTINGS and the page
    // would ignore everything the user previously saved.
    initialData: DEFAULT_SETTINGS,
    initialDataUpdatedAt: 0,
    staleTime: Infinity,
    refetchOnMount: 'always',
  })

  const save = useMutation({
    mutationFn: async (next: AppSettings) => {
      saveSettings(next)
      return next
    },
    onSuccess: (next) => {
      qc.setQueryData(SETTINGS_QUERY_KEY, next)
      toast.success('Settings saved')
    },
  })

  return (
    <div className="w-full max-w-md mx-auto px-4 pt-6 pb-12 space-y-6">
      <BackLink to="/wallet" label="Back to wallet" />

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure how Owl ID proves your credentials and manages your data on this device.
        </p>
      </header>

      <ProvingSection settings={settings.data} onSave={save.mutate} />
      <Separator />
      <RecoverySection settings={settings.data} onSave={save.mutate} />
      <Separator />
      <StorageSection />
      <Separator />
      <IdentitySection />
      <Separator />
      <AboutSection />
    </div>
  )
}

function ProvingSection({
  settings,
  onSave,
}: {
  settings: AppSettings
  onSave: (next: AppSettings) => void
}) {
  const [mode, setMode] = useState(settings.provingMode)
  const [url, setUrl] = useState(settings.proofServerUrl)
  const [testing, setTesting] = useState(false)
  const operatorUrl = getOperatorProofServerUrl()

  useEffect(() => {
    setMode(settings.provingMode)
    setUrl(settings.proofServerUrl)
  }, [settings.provingMode, settings.proofServerUrl])

  const validationError = mode === 'proof-server' ? validateProofServerUrl(url) : null
  const dirty = mode !== settings.provingMode || url !== settings.proofServerUrl
  const trimmedUrl = url.trim()
  const effectiveBackend = effectiveBackendLabel({ mode, url, operatorUrl })
  const usingCustom = mode === 'proof-server' && trimmedUrl.length > 0 && trimmedUrl !== operatorUrl

  const onTest = async () => {
    const target = trimmedUrl || operatorUrl
    if (!target) {
      toast.error('No proof server URL to test')
      return
    }
    const err = validateProofServerUrl(target)
    if (err) {
      toast.error(err)
      return
    }
    setTesting(true)
    const result = await pingProofServer(target)
    setTesting(false)
    if (result.ok) {
      toast.success(`Proof server reachable (HTTP ${result.status ?? 200})`)
    } else if (result.status) {
      toast.error(`Proof server responded HTTP ${result.status}`)
    } else {
      toast.error(`Cannot reach proof server: ${result.error ?? 'network error'}`)
    }
  }

  return (
    <Card data-testid="settings-section-proving">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Cpu className="w-4 h-4 text-muted-foreground" />
        <CardTitle className="text-base">Proving backend</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Owl ID builds a zero-knowledge proof every time you present a credential.{' '}
          <strong>WASM</strong> builds it inside this browser tab, so your private data never leaves
          the device. <strong>Hosted proof server</strong> hands the proof's private input to a
          hosted service that builds it for you — faster on low-power devices, but that input leaves
          your device.{' '}
          <a
            href="https://docs.owlid.app/architecture/overview"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-foreground"
          >
            Learn more
          </a>
          .
        </p>

        <RadioGroup
          value={mode}
          onValueChange={(v) => setMode(v as AppSettings['provingMode'])}
          className="space-y-3"
        >
          <Label htmlFor="proving-mode-wasm" className="flex items-start gap-3 cursor-pointer">
            <RadioGroupItem id="proving-mode-wasm" value="wasm" className="mt-1" />
            <div className="space-y-1">
              <span className="text-sm font-medium">WASM (in-process)</span>
              <span className="block text-xs text-muted-foreground">
                Maximum privacy. Witness stays on device. Slower first proof (key material download)
                but fast steady state.
              </span>
            </div>
          </Label>
          <Label htmlFor="proving-mode-server" className="flex items-start gap-3 cursor-pointer">
            <RadioGroupItem id="proving-mode-server" value="proof-server" className="mt-1" />
            <div className="space-y-1">
              <span className="text-sm font-medium">Hosted proof server</span>
              <span className="block text-xs text-muted-foreground">
                Faster on phones and tablets. The catch: the proof's private input leaves your
                device for the hosted server, so you have to trust its operator.
              </span>
            </div>
          </Label>
        </RadioGroup>

        {mode === 'proof-server' && (
          <div className="space-y-2">
            <Label htmlFor="proof-server-url" className="text-sm">
              Proof server URL
              <span className="text-muted-foreground"> (optional)</span>
            </Label>
            <Input
              id="proof-server-url"
              placeholder={operatorUrl || 'https://proofs.owlid.app'}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              aria-invalid={validationError != null}
              data-testid="settings-proof-server-url"
            />
            {validationError ? (
              <p className="text-xs text-destructive" role="alert">
                {validationError}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Leave blank to use{' '}
                {hasOperatorProofServer() ? (
                  <>
                    the operator default (<code>{operatorUrl}</code>).
                  </>
                ) : (
                  <>the built-in fallback.</>
                )}{' '}
                Custom URLs need <code>https://</code> (or <code>localhost</code>) and CORS headers
                for this Origin.
              </p>
            )}
            {usingCustom && !validationError && (
              <p className="text-xs text-amber-400/90">
                Using a custom server — your proof's private input is sent there. Trust the operator
                before enabling.
              </p>
            )}
          </div>
        )}

        <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Effective backend: </span>
          <span data-testid="settings-effective-backend">{effectiveBackend}</span>
        </div>

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {mode === 'proof-server' && (
            <Button
              variant="outline"
              size="sm"
              disabled={testing || validationError != null}
              onClick={onTest}
              data-testid="settings-proving-test"
            >
              {testing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                  Testing…
                </>
              ) : (
                'Test connection'
              )}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty}
            onClick={() => {
              setMode(settings.provingMode)
              setUrl(settings.proofServerUrl)
            }}
          >
            Revert
          </Button>
          <Button
            size="sm"
            disabled={!dirty || validationError != null}
            onClick={() =>
              onSave({
                provingMode: mode,
                proofServerUrl: normalizeProofServerUrl(url),
                encryptedRecoveryEnabled: settings.encryptedRecoveryEnabled,
              })
            }
            data-testid="settings-proving-save"
          >
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function RecoverySection({
  settings,
  onSave,
}: {
  settings: AppSettings
  onSave: (next: AppSettings) => void
}) {
  const enabled = settings.encryptedRecoveryEnabled
  return (
    <Card data-testid="settings-section-recovery">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <CloudUpload className="w-4 h-4 text-muted-foreground" />
        <CardTitle className="text-base">Encrypted recovery</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="encrypted-recovery" className="text-sm font-medium">
              Save encrypted credential backups
            </Label>
            <p className="text-xs text-muted-foreground">
              New credentials are backed up as passkey-encrypted ciphertext after provider
              verification. Owl ID can see that a backup exists for that provider identity, but not
              the credential contents or holder key.
            </p>
          </div>
          <Switch
            id="encrypted-recovery"
            checked={enabled}
            onCheckedChange={(checked) =>
              onSave({ ...settings, encryptedRecoveryEnabled: checked === true })
            }
            aria-label="Save encrypted credential backups"
          />
        </div>
        {enabled && (
          <p className="text-xs text-amber-400/90">
            Restoring still requires fresh provider verification and the same synced passkey. Keep a
            local device backup if your passkey provider does not sync PRF-capable passkeys.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function StorageSection() {
  const creds = useQuery({
    queryKey: ['wallet', 'credentials'],
    queryFn: () => storage.listCredentials(),
    staleTime: 0,
  })

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Database className="w-4 h-4 text-muted-foreground" />
        <CardTitle className="text-base">Storage</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <Row label="Credentials stored locally">
          {creds.isLoading ? '…' : String(creds.data?.length ?? 0)}
        </Row>
        <p className="text-xs text-muted-foreground pt-1">
          Credentials, passkeys, and proof receipts live in this browser&apos;s IndexedDB /
          localStorage. Clearing site data or resetting from the menu removes them permanently from
          this device. It does not revoke anything on the network — a credential already issued to
          you stays valid until it expires.
        </p>
      </CardContent>
    </Card>
  )
}

function IdentitySection() {
  const passkey = useQuery({
    queryKey: ['identity', 'webauthn'],
    queryFn: () => storage.loadWebAuthnCredential(),
    staleTime: 0,
  })

  const trimmedId = passkey.data?.credentialId
    ? `${passkey.data.credentialId.slice(0, 8)}…${passkey.data.credentialId.slice(-6)}`
    : null

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Fingerprint className="w-4 h-4 text-muted-foreground" />
        <CardTitle className="text-base">Identity</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <Row label="Passkey">
          {passkey.isLoading
            ? '…'
            : (trimmedId ?? <span className="text-muted-foreground">not registered</span>)}
        </Row>
        <p className="text-xs text-muted-foreground pt-1">
          Your saved passkey unlocks the local wallet keys that sign presentations. The passkey
          private key never leaves your authenticator or password manager.
        </p>
      </CardContent>
    </Card>
  )
}

function AboutSection() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Info className="w-4 h-4 text-muted-foreground" />
        <CardTitle className="text-base">About</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <Row label="App">Owl ID — Holder Wallet</Row>
        <Row label="Backend">
          <span className="flex items-center gap-1">
            <Server className="w-3 h-3" /> Midnight ZK predicates
          </span>
        </Row>
        <p className="text-xs text-muted-foreground pt-1">
          Open documentation lives at{' '}
          <a
            href="https://docs.owlid.app"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-foreground"
          >
            docs.owlid.app
          </a>
          .
        </p>
      </CardContent>
    </Card>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-xs">{children}</span>
    </div>
  )
}
