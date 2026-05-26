import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { ScanSearch, CheckCircle2, XCircle, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@owlid/ui/components/ui/card'
import { Button } from '@owlid/ui/components/ui/button'
import { Textarea } from '@owlid/ui/components/ui/textarea'
import { Input } from '@owlid/ui/components/ui/input'
import { Label } from '@owlid/ui/components/ui/label'
import { Badge } from '@owlid/ui/components/ui/badge'
import { useVerifyToken } from '~/hooks/use-verification'
import type { VerifyResponse } from '@owlid/verifier-client'
import { PageHeader } from '~/components/PageHeader'

export const Route = createFileRoute('/verify')({
  component: VerifyPage,
})

function VerifyPage() {
  const verify = useVerifyToken()
  const [tokenStr, setTokenStr] = useState('')
  const [challenge, setChallenge] = useState<string>(crypto.randomUUID())

  function handleVerify() {
    if (!tokenStr.trim()) {
      toast.error('Paste an SD-JWT VC presentation to verify')
      return
    }
    verify.mutate(
      { presentation: tokenStr.trim(), challenge },
      { onError: (err) => toast.error(err.message) },
    )
  }

  const result: VerifyResponse | undefined = verify.data

  return (
    <div className="space-y-6">
      <PageHeader
        title="Verify Token"
        description="Verify an SD-JWT VC presentation against the verification service"
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ScanSearch className="h-5 w-5" /> Token Input
            </CardTitle>
            <CardDescription>Paste a compact SD-JWT VC presentation</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="challenge">Challenge</Label>
              <div className="flex gap-2">
                <Input
                  id="challenge"
                  className="font-mono text-xs"
                  value={challenge}
                  onChange={(e) => setChallenge(e.target.value)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setChallenge(crypto.randomUUID())}
                  aria-label="Generate new challenge"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="token">Presentation</Label>
              <Textarea
                id="token"
                className="font-mono text-xs min-h-[220px]"
                placeholder="Paste the compact presentation string here"
                value={tokenStr}
                onChange={(e) => setTokenStr(e.target.value)}
              />
            </div>
            <Button
              onClick={handleVerify}
              disabled={verify.isPending || !tokenStr.trim()}
              className="w-full"
            >
              {verify.isPending ? 'Verifying…' : 'Verify'}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Result</CardTitle>
            <CardDescription>Verification outcome and disclosed claims</CardDescription>
          </CardHeader>
          <CardContent>
            {!result && !verify.isPending && (
              <p className="text-muted-foreground text-sm">
                Submit a presentation to see the result
              </p>
            )}
            {verify.isPending && <p className="text-muted-foreground text-sm">Verifying…</p>}

            {result && (
              <div className="space-y-4">
                {result.valid ? (
                  <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 text-base px-3 py-1">
                    <CheckCircle2 className="mr-2 h-4 w-4" /> Valid
                  </Badge>
                ) : (
                  <Badge variant="destructive" className="text-base px-3 py-1">
                    <XCircle className="mr-2 h-4 w-4" /> Invalid
                  </Badge>
                )}

                {result.error && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                    <p className="text-sm text-destructive">{result.error}</p>
                  </div>
                )}

                <SubjectsView subjects={result.subjects} />
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function SubjectsView({ subjects }: { subjects: unknown }) {
  if (!subjects || typeof subjects !== 'object') return null
  const entries = Object.entries(subjects as Record<string, unknown>)
  if (entries.length === 0) return null

  return (
    <div>
      <h4 className="text-sm font-medium mb-2">Disclosed Claims</h4>
      <div className="rounded-lg border divide-y">
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-start justify-between gap-4 px-3 py-2">
            <span className="text-xs font-medium text-muted-foreground">{key}</span>
            <span className="text-xs font-mono text-right break-all">
              {typeof value === 'object' ? JSON.stringify(value) : String(value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
