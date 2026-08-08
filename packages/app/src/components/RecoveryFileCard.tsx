import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, FileDown, FileUp, HardDriveDownload, Loader2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@owlid/ui/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@owlid/ui/components/ui/card'
import { Input } from '@owlid/ui/components/ui/input'
import { Label } from '@owlid/ui/components/ui/label'
import { exportWalletRecoveryFile, importWalletRecoveryFile } from '~/lib/credential-recovery'

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function RecoveryFileCard() {
  const qc = useQueryClient()
  const [code, setCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [importCode, setImportCode] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const [pendingFile, setPendingFile] = useState<{ name: string; text: string } | null>(null)

  const exportMut = useMutation({
    mutationFn: exportWalletRecoveryFile,
    onSuccess: ({ file, code, count }) => {
      const stamp = new Date().toISOString().slice(0, 10)
      downloadJson(`owlid-recovery-${stamp}.json`, file)
      setCode(code)
      setCopied(false)
      toast.success(`Recovery file for ${count} credential${count === 1 ? '' : 's'} downloaded`)
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not create recovery file'),
  })

  const importMut = useMutation({
    mutationFn: async () => {
      if (!pendingFile) throw new Error('Choose a recovery file first')
      if (!importCode.trim()) throw new Error('Enter the recovery code')
      return importWalletRecoveryFile(pendingFile.text, importCode)
    },
    onSuccess: (restored) => {
      qc.invalidateQueries({ queryKey: ['wallet'] })
      setPendingFile(null)
      setImportCode('')
      if (fileInput.current) fileInput.current.value = ''
      toast.success(
        `Restored ${restored.length} credential${restored.length === 1 ? '' : 's'} to this device`,
      )
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Restore failed'),
  })

  const copyCode = async () => {
    if (!code) return
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Card data-testid="settings-section-recovery-file">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <HardDriveDownload className="w-4 h-4 text-muted-foreground" />
        <CardTitle className="text-base">Offline recovery file</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-xs text-muted-foreground">
          A passkey-independent backup you keep. Encrypted under a recovery code shown once — works
          even if your passkey is lost or never synced, and restores onto a new device (your second
          device, too). The code is the only key: lose it and the file is useless; share it and the
          file is exposed.
        </p>

        {/* Export */}
        <div className="space-y-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => exportMut.mutate()}
            disabled={exportMut.isPending}
            data-testid="recovery-file-export"
          >
            {exportMut.isPending ? (
              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
            ) : (
              <FileDown className="w-3.5 h-3.5 mr-1" />
            )}
            Create recovery file
          </Button>

          {code && (
            <div className="rounded-md border border-amber-400/40 bg-amber-400/5 p-3 space-y-2">
              <p className="text-xs font-medium text-amber-300">
                Write this recovery code down now. It is shown only once.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-background/60 px-2 py-1 text-sm tracking-wide">
                  {code}
                </code>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={copyCode}
                  aria-label="Copy recovery code"
                >
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Import */}
        <div className="space-y-2 border-t border-border/60 pt-4">
          <Label className="text-sm font-medium">Restore from a recovery file</Label>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (!f) return
              setPendingFile({ name: f.name, text: await f.text() })
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => fileInput.current?.click()}
              data-testid="recovery-file-choose"
            >
              <FileUp className="w-3.5 h-3.5 mr-1" />
              {pendingFile ? 'Change file' : 'Choose file'}
            </Button>
            {pendingFile && (
              <span className="text-xs text-muted-foreground truncate max-w-[12rem]">
                {pendingFile.name}
              </span>
            )}
          </div>
          <Input
            value={importCode}
            onChange={(e) => setImportCode(e.target.value)}
            placeholder="Recovery code"
            autoCapitalize="characters"
            spellCheck={false}
            data-testid="recovery-file-code"
          />
          <Button
            size="sm"
            onClick={() => importMut.mutate()}
            disabled={importMut.isPending || !pendingFile || !importCode.trim()}
            data-testid="recovery-file-import"
          >
            {importMut.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null}
            Restore credentials
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
