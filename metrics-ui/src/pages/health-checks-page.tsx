'use client'

import { PlusIcon } from 'lucide-react'
import { AppShell, DashboardPage } from '../components/app-shell.tsx'
import { ChartGrid, TimeSeriesChart } from '../components/charts.tsx'
import { ChartCard, KpiCard, KpiRow, PageHeader, QueryBar, SectionTitle } from '../components/chrome.tsx'
import { createAppColumnHelper, DataTable } from '../components/data-table.tsx'
import { Button } from '../components/ui/button.tsx'
import { CHECK_TONE, Mono, StatusRing, UptimeStrip } from '../components/widgets.tsx'
import { COLORS } from '../lib/chart-colors.ts'
import { checkLatency, checkRuns, HEALTH_CHECKS, type HealthCheck } from '../lib/mock-data.ts'
import { cn, formatMs, formatPercent, timeAgo } from '../lib/utils.ts'

const uptime = (check: HealthCheck) => check.uptimeDays.reduce((sum, ratio) => sum + ratio, 0) / check.uptimeDays.length

const GROUPS = [
  { id: 'down', label: 'Down', icon: <StatusRing tone="destructive" /> },
  { id: 'degraded', label: 'Degraded', icon: <StatusRing tone="warning" /> },
  { id: 'up', label: 'Operational', icon: <StatusRing tone="success" /> },
]

const helper = createAppColumnHelper<HealthCheck>()

const columns = helper.columns([
  helper.accessor('name', {
    header: 'Check',
    meta: { className: 'w-[34%] max-w-0' },
    cell: (info) => {
      const check = info.row.original
      return (
        <span className="flex min-w-0 flex-col py-1.5 leading-4">
          <span className="font-medium">{check.name}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {check.method} {check.url}
          </span>
          {check.errorMessage ? <span className="truncate text-xs text-destructive">{check.errorMessage}</span> : null}
        </span>
      )
    },
  }),
  helper.accessor('uptimeDays', {
    header: 'Last 90 days',
    enableSorting: false,
    cell: (info) => <UptimeStrip days={info.getValue()} />,
  }),
  helper.accessor(uptime, {
    id: 'uptime',
    header: 'Uptime',
    meta: { className: 'text-right' },
    cell: (info) => (
      <span className={cn('tabular-nums', info.getValue() < 0.999 ? 'text-warning' : 'text-foreground')}>
        {formatPercent(info.getValue(), 2)}
      </span>
    ),
  }),
  helper.accessor('p50Ms', {
    header: 'p50',
    meta: { className: 'text-right' },
    cell: (info) => <span className="text-muted-foreground tabular-nums">{formatMs(info.getValue())}</span>,
  }),
  helper.accessor('p95Ms', {
    header: 'p95',
    meta: { className: 'text-right' },
    cell: (info) => (
      <span className={cn('tabular-nums', info.getValue() > 1000 ? 'text-warning' : 'text-muted-foreground')}>
        {formatMs(info.getValue())}
      </span>
    ),
  }),
  helper.accessor('lastCheckedAt', {
    header: 'Last check',
    meta: { className: 'text-right' },
    cell: (info) => (
      <span className="flex items-center justify-end gap-2 tabular-nums">
        <Mono className={info.row.original.lastStatusCode >= 400 ? 'text-destructive' : 'text-muted-foreground'}>
          {info.row.original.lastStatusCode}
        </Mono>
        <span className="text-muted-foreground">{timeAgo(info.getValue())}</span>
      </span>
    ),
  }),
  helper.accessor('schedule', {
    header: 'Schedule',
    enableSorting: false,
    cell: (info) => <Mono className="text-muted-foreground">{info.getValue()}</Mono>,
  }),
])

export function HealthChecksPage() {
  const down = HEALTH_CHECKS.filter((check) => check.status === 'down').length
  const up = HEALTH_CHECKS.filter((check) => check.status !== 'down').length

  return (
    <AppShell>
      <DashboardPage>
        <PageHeader
          title="Health checks"
          meta={`${HEALTH_CHECKS.length} checks · ${down} down`}
          actions={
            <Button size="sm">
              <PlusIcon /> New check
            </Button>
          }
        />
        <QueryBar
          placeholder="checks that failed today…"
          examples={['down in the last 24h', 'slower than 500ms', 'status 5xx this week']}
          sql="Timestamp >= now() - INTERVAL 24 HOUR AND Success = 0"
        />

        <KpiRow>
          <KpiCard label="Operational" value={`${up}/${HEALTH_CHECKS.length}`} tone={down ? 'destructive' : 'success'} live />
          <KpiCard label="Uptime · 90 days" value="99.91%" hint="SLA target 99.9%" />
          <KpiCard label="Avg latency" value="112ms" delta={0.08} lowerIsBetter />
          <KpiCard label="Incidents · 30 days" value="3" hint="last: Checkout API, 2m ago" />
        </KpiRow>

        <section className="flex flex-col gap-2">
          <SectionTitle meta="grouped by current status">Checks</SectionTitle>
          <DataTable
            columns={columns}
            data={HEALTH_CHECKS}
            getRowId={(check) => check.checkId}
            groups={GROUPS}
            getGroupId={(check) => check.status}
          />
        </section>

        <ChartGrid>
          <ChartCard
            title="Check results"
            legend={[
              { color: COLORS.success, label: 'Success' },
              { color: COLORS.error, label: 'Failed' },
            ]}
          >
            <TimeSeriesChart
              data={checkRuns}
              series={[
                { key: 'success', label: 'Success', color: COLORS.success, kind: 'bar' },
                { key: 'failed', label: 'Failed', color: COLORS.error, kind: 'bar' },
              ]}
              stacked
              ariaLabel="Check results"
              valueFormat={(value) => `${value.toFixed(0)} checks`}
            />
          </ChartCard>
          <ChartCard
            title="Response time"
            legend={[
              { color: COLORS.p50, label: 'p50' },
              { color: COLORS.p95, label: 'p95' },
            ]}
          >
            <TimeSeriesChart
              data={checkLatency}
              series={[
                { key: 'p95', label: 'p95', color: COLORS.p95, kind: 'line' },
                { key: 'p50', label: 'p50', color: COLORS.p50, kind: 'area', fillOpacity: 0.12 },
              ]}
              ariaLabel="Check response time"
              yFormat={formatMs}
              valueFormat={formatMs}
            />
          </ChartCard>
        </ChartGrid>
      </DashboardPage>
    </AppShell>
  )
}
