import { createFileRoute, Link } from '@tanstack/react-router'
import {
  Activity,
  CheckCircle2,
  XCircle,
  TrendingUp,
  Moon,
  ShieldCheck,
  Ban,
  Key,
  ArrowRight,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@owlid/ui/components/ui/card'
import { Progress } from '@owlid/ui/components/ui/progress'
import { Skeleton } from '@owlid/ui/components/ui/skeleton'
import {
  useMetrics,
  useVerificationHealth,
  useTrustedIssuers,
  useRevokedCredentials,
} from '~/hooks/use-verification'
import { useIssuerHealth } from '~/hooks/use-issuer'
import { useMidnightStatus } from '~/hooks/use-midnight'
import { useApiKeys, useAuditEvents } from '~/hooks/use-admin'
import { ServiceStatusCard, type ServiceState } from '~/components/ServiceStatusCard'
import { PageHeader } from '~/components/PageHeader'
import { RelativeTime } from '~/components/RelativeTime'
import { getIssuerUrl, getVerificationUrl } from '@owlid/config'

export const Route = createFileRoute('/')({
  component: DashboardPage,
})

function DashboardPage() {
  const metrics = useMetrics()
  const verificationHealth = useVerificationHealth()
  const issuerHealth = useIssuerHealth()
  const midnight = useMidnightStatus()
  const issuers = useTrustedIssuers()
  const revoked = useRevokedCredentials()
  const apiKeys = useApiKeys()
  const audit = useAuditEvents({ limit: 6 })

  const successRate = metrics.data?.successRate ?? 0

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
    if (!midnight.data.sidecar.reachable) return 'unreachable'
    if (!midnight.data.sidecar.connected) return 'degraded'
    return 'healthy'
  })()

  const activeKeys = apiKeys.data?.filter((k) => k.isActive).length

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" description="System overview and service health" />

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

      <div className="grid gap-4 md:grid-cols-4">
        <MetricCard
          label="Total Verifications"
          value={metrics.data?.totalVerifications}
          loading={metrics.isLoading}
          icon={<Activity className="h-4 w-4 text-muted-foreground" />}
        />
        <MetricCard
          label="Successful"
          value={metrics.data?.successfulVerifications}
          loading={metrics.isLoading}
          icon={<CheckCircle2 className="h-4 w-4 text-emerald-500" />}
          valueClass="text-emerald-500"
        />
        <MetricCard
          label="Failed"
          value={metrics.data?.failedVerifications}
          loading={metrics.isLoading}
          icon={<XCircle className="h-4 w-4 text-destructive" />}
          valueClass="text-destructive"
        />
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {metrics.isLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <>
                <div className="text-2xl font-bold">{successRate.toFixed(1)}%</div>
                <Progress value={successRate} className="mt-2" />
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <CountCard
          to="/issuers"
          label="Trusted Issuers"
          count={issuers.data?.length}
          loading={issuers.isLoading}
          icon={<ShieldCheck className="h-4 w-4" />}
        />
        <CountCard
          to="/revocations"
          label="Revoked / Suspended"
          count={revoked.data?.length}
          loading={revoked.isLoading}
          icon={<Ban className="h-4 w-4" />}
        />
        <CountCard
          to="/api-keys"
          label="Active API Keys"
          count={activeKeys}
          loading={apiKeys.isLoading}
          icon={<Key className="h-4 w-4" />}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Activity</CardTitle>
          <CardDescription>Latest audit-trail events</CardDescription>
        </CardHeader>
        <CardContent>
          {audit.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-5 w-full" />
              ))}
            </div>
          ) : !audit.data || audit.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
          ) : (
            <ul className="divide-y">
              {audit.data.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-4 py-2 text-sm">
                  <span className="font-medium">{e.eventType.replace(/_/g, ' ')}</span>
                  <code className="text-xs text-muted-foreground truncate max-w-[40%]">
                    {e.entityId}
                  </code>
                  <RelativeTime value={e.occurredAt} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function MetricCard({
  label,
  value,
  loading,
  icon,
  valueClass,
}: {
  label: string
  value?: number
  loading: boolean
  icon: React.ReactNode
  valueClass?: string
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{label}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          <div className={`text-2xl font-bold ${valueClass ?? ''}`}>{value ?? '—'}</div>
        )}
      </CardContent>
    </Card>
  )
}

function CountCard({
  to,
  label,
  count,
  loading,
  icon,
}: {
  to: string
  label: string
  count?: number
  loading: boolean
  icon: React.ReactNode
}) {
  return (
    <Link to={to} className="group">
      <Card className="transition-colors group-hover:border-primary/50">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            {icon}
            {label}
          </CardTitle>
          <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-8 w-12" />
          ) : (
            <div className="text-2xl font-bold">{count ?? '—'}</div>
          )}
        </CardContent>
      </Card>
    </Link>
  )
}
