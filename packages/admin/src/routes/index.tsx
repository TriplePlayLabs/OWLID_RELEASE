import { createFileRoute } from '@tanstack/react-router'
import { Activity, CheckCircle2, XCircle, TrendingUp, Server } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card'
import { Badge } from '~/components/ui/badge'
import { Progress } from '~/components/ui/progress'
import { useMetrics, useVerificationHealth } from '~/hooks/use-verification'
import { useIssuerHealth } from '~/hooks/use-issuer'

export const Route = createFileRoute('/')({
  component: DashboardPage,
})

function DashboardPage() {
  const metrics = useMetrics()
  const verificationHealth = useVerificationHealth()
  const issuerHealth = useIssuerHealth()

  const successRate = metrics.data?.successRate ?? 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">System overview and service health</p>
      </div>

      {/* Service Health */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Verification Service</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              {verificationHealth.isLoading ? (
                <Badge variant="outline">Checking...</Badge>
              ) : verificationHealth.data ? (
                <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
                  <CheckCircle2 className="mr-1 h-3 w-3" /> Healthy
                </Badge>
              ) : (
                <Badge variant="destructive">
                  <XCircle className="mr-1 h-3 w-3" /> Unreachable
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">:8000</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Issuer Service</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              {issuerHealth.isLoading ? (
                <Badge variant="outline">Checking...</Badge>
              ) : issuerHealth.data ? (
                <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
                  <CheckCircle2 className="mr-1 h-3 w-3" /> Healthy
                </Badge>
              ) : (
                <Badge variant="destructive">
                  <XCircle className="mr-1 h-3 w-3" /> Unreachable
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">:8001</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Metrics */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Verifications</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{metrics.data?.totalVerifications ?? '—'}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Successful</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-500">
              {metrics.data?.successfulVerifications ?? '—'}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Failed</CardTitle>
            <XCircle className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">
              {metrics.data?.failedVerifications ?? '—'}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{successRate.toFixed(1)}%</div>
            <Progress value={successRate} className="mt-2" />
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
          <CardDescription>Common admin operations</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-3">
          <a href="/issuers" className="rounded-lg border p-4 hover:bg-accent transition-colors">
            <h3 className="font-medium">Manage Trusted Issuers</h3>
            <p className="text-sm text-muted-foreground">Add or view trusted issuer public keys</p>
          </a>
          <a
            href="/revocations"
            className="rounded-lg border p-4 hover:bg-accent transition-colors"
          >
            <h3 className="font-medium">Revocation Registry</h3>
            <p className="text-sm text-muted-foreground">
              Revoke, suspend, or reactivate credentials
            </p>
          </a>
          <a href="/verify" className="rounded-lg border p-4 hover:bg-accent transition-colors">
            <h3 className="font-medium">Verify Token</h3>
            <p className="text-sm text-muted-foreground">
              Verify a proof token against the service
            </p>
          </a>
        </CardContent>
      </Card>
    </div>
  )
}
