import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { ScanSearch, CheckCircle2, XCircle } from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card'
import { Button } from '~/components/ui/button'
import { Textarea } from '~/components/ui/textarea'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Badge } from '~/components/ui/badge'
import { useVerifyToken } from '~/hooks/use-verification'
import type { VerifyResponse } from '@owlid/sdk'

export const Route = createFileRoute('/verify')({
  component: VerifyPage,
})

function VerifyPage() {
  const verify = useVerifyToken()
  const [tokenStr, setTokenStr] = useState('')
  const [challenge, setChallenge] = useState(crypto.randomUUID())

  function handleVerify() {
    if (!tokenStr.trim()) {
      toast.error('Paste a token to verify')
      return
    }
    verify.mutate(
      { token: tokenStr.trim(), challenge },
      { onError: (err) => toast.error(err.message) },
    )
  }

  const result: VerifyResponse | undefined = verify.data

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Verify Token</h1>
        <p className="text-muted-foreground">
          Verify a proof token against the verification service
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ScanSearch className="h-5 w-5" /> Token Input
            </CardTitle>
            <CardDescription>Paste a compact proof token</CardDescription>
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
                >
                  New
                </Button>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="token">Token</Label>
              <Textarea
                id="token"
                className="font-mono text-xs min-h-[200px]"
                placeholder="Paste the compact token string here"
                value={tokenStr}
                onChange={(e) => setTokenStr(e.target.value)}
              />
            </div>
            <Button onClick={handleVerify} disabled={verify.isPending} className="w-full">
              {verify.isPending ? 'Verifying...' : 'Verify'}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Result</CardTitle>
          </CardHeader>
          <CardContent>
            {!result && !verify.isPending && (
              <p className="text-muted-foreground text-sm">Submit a token to see the result</p>
            )}

            {verify.isPending && <p className="text-muted-foreground text-sm">Verifying...</p>}

            {result && (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  {result.valid ? (
                    <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 text-base px-3 py-1">
                      <CheckCircle2 className="mr-2 h-4 w-4" /> Valid
                    </Badge>
                  ) : (
                    <Badge variant="destructive" className="text-base px-3 py-1">
                      <XCircle className="mr-2 h-4 w-4" /> Invalid
                    </Badge>
                  )}
                </div>

                {result.error && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                    <p className="text-sm text-destructive">{result.error}</p>
                  </div>
                )}

                {result.subjects &&
                  typeof result.subjects === 'object' &&
                  Object.keys(result.subjects).length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium mb-2">Disclosed Subjects</h4>
                      <div className="rounded-lg border bg-muted/50 p-3">
                        <pre className="text-xs overflow-auto whitespace-pre-wrap">
                          {JSON.stringify(result.subjects, null, 2)}
                        </pre>
                      </div>
                    </div>
                  )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
