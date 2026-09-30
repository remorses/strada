'use client'

import { useState } from 'react'
import { AppShell, DashboardPage } from '../components/app-shell.tsx'
import { CategoryBarChart, ChartGrid, TimeSeriesChart } from '../components/charts.tsx'
import { ChartCard, KpiCard, KpiRow, PageHeader, QueryBar, SectionTitle } from '../components/chrome.tsx'
import { createAppColumnHelper, DataTable } from '../components/data-table.tsx'
import {
  DetailPanel,
  Dot,
  DurationBar,
  MetaList,
  MiniBars,
  Mono,
  PanelSection,
  Pill,
  ShareBar,
} from '../components/widgets.tsx'
import { COLORS } from '../lib/chart-colors.ts'
import {
  ENDPOINTS,
  latencyHistogram,
  SLOW_TRACES,
  traceLatency,
  traceThroughput,
  type Endpoint,
  type TraceSummary,
} from '../lib/mock-data.ts'
import { cn, formatCompact, formatMs, formatPercent, timeAgo } from '../lib/utils.ts'

// Approximate time spent per endpoint, used to rank the most expensive operations.
const totalTime = (endpoint: Endpoint) => endpoint.count * endpoint.p50
const allTime = ENDPOINTS.reduce((sum, endpoint) => sum + totalTime(endpoint), 0)

const endpointHelper = createAppColumnHelper<Endpoint>()

const endpointColumns = endpointHelper.columns([
  endpointHelper.accessor('spanName', {
    header: 'Operation',
    meta: { className: 'w-full max-w-0' },
    cell: (info) => (
      <span className="flex min-w-0 items-center gap-2">
        <Pill className="shrink-0">{info.row.original.serviceName}</Pill>
        <Mono className="truncate">{info.getValue()}</Mono>
        <span className="text-[11px] text-muted-foreground">{info.row.original.spanKind}</span>
      </span>
    ),
  }),
  endpointHelper.accessor('count', {
    header: 'Requests',
    meta: { className: 'text-right' },
    cell: (info) => <span className="tabular-nums">{formatCompact(info.getValue())}</span>,
  }),
  endpointHelper.accessor('errorRate', {
    header: 'Errors',
    meta: { className: 'text-right' },
    cell: (info) => (
      <span className={cn('tabular-nums', info.getValue() > 0.01 ? 'text-destructive' : 'text-muted-foreground')}>
        {formatPercent(info.getValue())}
      </span>
    ),
  }),
  endpointHelper.accessor('p50', {
    header: 'p50',
    meta: { className: 'text-right' },
    cell: (info) => <span className="text-muted-foreground tabular-nums">{formatMs(info.getValue())}</span>,
  }),
  endpointHelper.accessor('p95', {
    header: 'p95',
    meta: { className: 'text-right' },
    cell: (info) => <span className="tabular-nums">{formatMs(info.getValue())}</span>,
  }),
  endpointHelper.accessor('p99', {
    header: 'p99',
    meta: { className: 'text-right' },
    cell: (info) => (
      <span className={cn('tabular-nums', info.getValue() > 2000 ? 'text-warning' : 'text-muted-foreground')}>
        {formatMs(info.getValue())}
      </span>
    ),
  }),
  endpointHelper.accessor((endpoint) => totalTime(endpoint) / allTime, {
    id: 'share',
    header: 'Time spent',
    cell: (info) => (
      <span className="flex items-center gap-2">
        <ShareBar value={info.getValue()} />
        <span className="w-9 text-right text-muted-foreground tabular-nums">{formatPercent(info.getValue(), 0)}</span>
      </span>
    ),
  }),
  endpointHelper.display({
    id: 'spark',
    header: '24h',
    cell: (info) => <MiniBars values={info.row.original.spark} tone="info" />,
  }),
])

const maxTrace = Math.max(...SLOW_TRACES.map((trace) => trace.durationMs))
const traceHelper = createAppColumnHelper<TraceSummary>()

const traceColumns = traceHelper.columns([
  traceHelper.accessor('rootSpanName', {
    header: 'Root span',
    meta: { className: 'w-[40%] max-w-0' },
    cell: (info) => (
      <span className="flex min-w-0 items-center gap-2">
        <Dot tone={info.row.original.errorSpanCount > 0 ? 'destructive' : 'success'} />
        <Mono className="truncate">{info.getValue()}</Mono>
      </span>
    ),
  }),
  traceHelper.accessor('services', {
    header: 'Services',
    enableSorting: false,
    cell: (info) => (
      <span className="flex gap-1">
        {info.getValue().map((service) => (
          <Pill key={service}>{service}</Pill>
        ))}
      </span>
    ),
  }),
  traceHelper.accessor('spanCount', {
    header: 'Spans',
    meta: { className: 'text-right' },
    cell: (info) => (
      <span className="text-muted-foreground tabular-nums">
        {info.getValue()}
        {info.row.original.errorSpanCount > 0 ? (
          <span className="ml-1.5 text-destructive">{info.row.original.errorSpanCount} err</span>
        ) : null}
      </span>
    ),
  }),
  traceHelper.accessor('durationMs', {
    header: 'Duration',
    meta: { className: 'w-[28%]' },
    cell: (info) => (
      <DurationBar
        value={info.getValue()}
        max={maxTrace}
        label={formatMs(info.getValue())}
        tone={info.row.original.errorSpanCount > 0 ? 'destructive' : 'info'}
      />
    ),
  }),
  traceHelper.accessor('startTime', {
    header: 'Started',
    meta: { className: 'text-right' },
    cell: (info) => <span className="text-muted-foreground tabular-nums">{timeAgo(info.getValue())}</span>,
  }),
])

export function TracesPage() {
  const [traceId, setTraceId] = useState<string>()
  const trace = SLOW_TRACES.find((item) => item.traceId === traceId)

  return (
    <AppShell>
      <DashboardPage>
        <PageHeader title="Traces" meta="184k requests · last 24 hours" />
        <QueryBar
          placeholder="since 2 hours ago, only service api…"
          examples={['slower than 1s', 'errors in worker', 'POST /api/checkout']}
          sql="Timestamp >= now() - INTERVAL 24 HOUR AND Duration > 1000000000"
        />

        <KpiRow>
          <KpiCard label="Requests" value="184k" delta={0.094} />
          <KpiCard label="Error rate" value="0.62%" delta={0.31} lowerIsBetter />
          <KpiCard label="p50 latency" value="52ms" delta={-0.04} lowerIsBetter />
          <KpiCard label="p95 latency" value="186ms" delta={0.22} lowerIsBetter />
        </KpiRow>

        <ChartGrid className="lg:grid-cols-3">
          <ChartCard
            title="Throughput"
            legend={[
              { color: COLORS.primary, label: 'OK' },
              { color: COLORS.error, label: 'Error' },
            ]}
          >
            <TimeSeriesChart
              data={traceThroughput}
              series={[
                { key: 'ok', label: 'OK', color: COLORS.primary, kind: 'bar' },
                { key: 'error', label: 'Error', color: COLORS.error, kind: 'bar' },
              ]}
              stacked
              ariaLabel="Throughput"
              yFormat={formatCompact}
              valueFormat={(value) => `${value.toLocaleString()} req`}
            />
          </ChartCard>
          <ChartCard
            title="Latency"
            legend={[
              { color: COLORS.p50, label: 'p50' },
              { color: COLORS.p95, label: 'p95' },
              { color: COLORS.p99, label: 'p99' },
            ]}
          >
            <TimeSeriesChart
              data={traceLatency}
              series={[
                { key: 'p99', label: 'p99', color: COLORS.p99, kind: 'line', strokeWidth: 1.4 },
                { key: 'p95', label: 'p95', color: COLORS.p95, kind: 'line' },
                { key: 'p50', label: 'p50', color: COLORS.p50, kind: 'area', fillOpacity: 0.12 },
              ]}
              ariaLabel="Latency percentiles"
              yFormat={formatMs}
              valueFormat={formatMs}
            />
          </ChartCard>
          <ChartCard title="Duration distribution">
            <CategoryBarChart
              rows={latencyHistogram}
              colors={{ Requests: COLORS.primary }}
              ariaLabel="Duration distribution"
              yFormat={formatCompact}
            />
          </ChartCard>
        </ChartGrid>

        <section className="flex flex-col gap-2">
          <SectionTitle meta="grouped by service and span name, sorted by time spent">Operations</SectionTitle>
          <DataTable columns={endpointColumns} data={[...ENDPOINTS].sort((a, b) => totalTime(b) - totalTime(a))} getRowId={(row) => `${row.serviceName}:${row.spanName}`} />
        </section>

        <section className="flex min-w-0 flex-col gap-2">
          <SectionTitle meta="root spans, last 24 hours">Slowest traces</SectionTitle>
          <div className="flex items-start gap-4">
            <DataTable
              className="min-w-0 flex-1"
              columns={traceColumns}
              data={SLOW_TRACES}
              getRowId={(row) => row.traceId}
              activeRowId={traceId}
              onRowClick={(row) => setTraceId(row.traceId)}
            />
            {trace ? <TracePreview trace={trace} onClose={() => setTraceId(undefined)} /> : null}
          </div>
        </section>
      </DashboardPage>
    </AppShell>
  )
}

function TracePreview({ trace, onClose }: { trace: TraceSummary; onClose: () => void }) {
  return (
    <DetailPanel onClose={onClose} title={<Mono>{trace.rootSpanName}</Mono>}>
      <MetaList
        items={[
          { label: 'Trace ID', value: <Mono>{trace.traceId}</Mono> },
          { label: 'Duration', value: formatMs(trace.durationMs) },
          { label: 'Spans', value: trace.spanCount },
          { label: 'Errors', value: <span className={trace.errorSpanCount ? 'text-destructive' : 'text-success'}>{trace.errorSpanCount}</span> },
          { label: 'Started', value: timeAgo(trace.startTime) },
          { label: 'Root service', value: trace.rootServiceName },
        ]}
      />
      <PanelSection title="Services">
        <span className="flex flex-wrap gap-1">
          {trace.services.map((service) => (
            <Pill key={service}>{service}</Pill>
          ))}
        </span>
      </PanelSection>
    </DetailPanel>
  )
}
