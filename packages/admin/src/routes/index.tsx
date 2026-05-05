import { createFileRoute } from '@tanstack/react-router'
import { Activity, CheckCircle2, XCircle, TrendingUp, Moon } from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@owlid/ui/components/ui/card'
import { Progress } from '@owlid/ui/components/ui/progress'
import { useMetrics, useVerificationHealth } from '~/hooks/use-verification'
import { useIssuerHealth } from '~/hooks/use-issuer'
import { useMidnightStatus } from '~/hooks/use-midnight'
import { ServiceStatusCard, type ServiceState } from '~/components/ServiceStatusCard'
import { getIssuerUrl, getVerificationUrl } from '@owlid/config'

export const Route = createFileRoute('/')({
  component: DashboardPage,
})

function DashboardPage() {
  const metrics = useMetrics()
  const verificationHealth = useVerificationHealth()
  const issuerHealth = useIssuerHealth()
  const midnight = useMidnightStatus()

  const successRate = metrics.data?.successRate ?? 0

  // Map each service's hook state into the unified card's `state` enum so
  // the dashboard renders consistently.
  const verificationState: ServiceState = verificationHealth.isLoading
    ? 'loading'
    : verificationHealth.data?.ok
      ? 'healthy'
      : 'unreachable'
  const issuerState: ServiceState = issuerHealth.isLoading
    ? 'loading'
    : issuerHealth.data?.ok
      ? 'healthy'
      : 'unreachable'
  const midnightState: ServiceState = (() => {
    if (midnight.isLoading) return 'loading'
    if (!midnight.data) return 'unreachable'
    if (!midnight.data.configured) return 'disabled'
    if (!midnight.data.enabled) return 'disabled'
    if (!midnight.data.sidecar.reachable) return 'unreachable'
    if (!midnight.data.sidecar.connected) return 'degraded'
    return 'healthy'
  })()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">System overview and service health</p>
      </div>

      {/* Service Health */}
      <div className="grid gap-4 md:grid-cols-3">
        <ServiceStatusCard
          name="Verification Service"
          url={getVerificationUrl()}
          state={verificationState}
          latencyMs={verificationHealth.data?.latencyMs}
        />
        <ServiceStatusCard
          name="Issuer Service"
          url={getIssuerUrl()}
          state={issuerState}
          latencyMs={issuerHealth.data?.latencyMs}
        />
        <ServiceStatusCard
          name="Midnight Sidecar"
          url={midnight.data?.sidecarUrl}
          state={midnightState}
          latencyMs={midnight.data?.sidecar.latencyMs}
          detail={midnight.data?.sidecar.error ?? undefined}
          icon={<Moon className="h-4 w-4 text-muted-foreground" />}
        />
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
