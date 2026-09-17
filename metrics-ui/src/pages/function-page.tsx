'use client'

import {
  Breadcrumbs,
  ChartCard,
  MetricTabs,
  PageBody,
  PageShell,
  PageTitle,
  ShowDeploymentsToggle,
  StatusPills,
  TimeRangeBar,
} from '../components/chrome.tsx'
import { ChartGrid, PercentileChart, TimeSeriesChart } from '../components/charts.tsx'
import { COLORS } from '../lib/chart-colors.ts'
import {
  APP_NAME,
  cpuSeries,
  containerSeries,
  executionPercentiles,
  executionTimeSeries,
  functionCallResults,
  FUNCTION_NAME,
  memorySeries,
  networkSeries,
  pendingCallsSeries,
  runningCallsSeries,
  taskRegistrySeries,
} from '../lib/metrics-data.ts'
import { formatCores, formatDuration, formatGiB, formatRate } from '../lib/utils.ts'

export function FunctionPage() {
  return (
    <PageShell>
      <PageBody>
        <Breadcrumbs
          items={[
            { label: 'Apps', href: '/sandboxes' },
            { label: APP_NAME, href: '/sandboxes' },
            { label: 'Functions' },
          ]}
        />
        <PageTitle copied>{FUNCTION_NAME}</PageTitle>
        <TimeRangeBar />
        <div className="flex flex-wrap items-center gap-3">
          <StatusPills
            items={[
              { label: 'Containers', value: '26 live (+654 draining)' },
              { label: 'Calls', value: '680 running' },
            ]}
          />
          <ShowDeploymentsToggle />
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="text-center text-sm font-medium">Function call results</h2>
          <div className="relative">
            <TimeSeriesChart
              data={functionCallResults}
              series={[{ key: 'success', label: 'success', color: COLORS.success, kind: 'bar' }]}
              ariaLabel="Function call results"
              valueFormat={(value) => value.toFixed(0)}
              height={140}
              yTicks={[0, 2, 4]}
              yFormat={(value) => value.toFixed(1)}
            />
          </div>
        </section>

        <MetricTabs
          active="Metrics"
          items={[
            { href: '/', label: 'Function Calls' },
            { href: '/', label: 'Containers' },
            { href: '/', label: '2 errors', badge: '2 errors', badgeTone: 'destructive', badgeOnly: true },
            { href: '/', label: 'Metrics' },
            { href: '/', label: 'Details' },
            { href: '/', label: 'Files' },
            { href: '/', label: 'Try It', badge: 'Beta', badgeTone: 'info' },
          ]}
        />

        <ChartGrid>
          <ChartCard
            title="Containers"
            expand
            legend={[
              { color: COLORS.live, label: 'Live' },
              { color: COLORS.live, label: 'Total' },
            ]}
          >
            <div className="relative">
              <TimeSeriesChart
                data={containerSeries}
                series={[
                  { key: 'live', label: 'Live', color: COLORS.live, kind: 'area', fillOpacity: 0.1 },
                  { key: 'total', label: 'Total', color: COLORS.live, kind: 'line', strokeWidth: 1.4 },
                ]}
                ariaLabel="Containers"
                valueFormat={(value) => `${value.toFixed(0)} containers`}
                yTicks={[0, 500]}
              />
            </div>
          </ChartCard>

          <ChartCard
            title="CPU"
            legend={[
              { color: COLORS.usedCpu, label: 'Used' },
              { color: COLORS.request, label: 'Request' },
            ]}
          >
            <div className="relative">
              <TimeSeriesChart
                data={cpuSeries}
                series={[
                  { key: 'request', label: 'Request', color: COLORS.request, kind: 'area', fillOpacity: 0.14 },
                  { key: 'used', label: 'Used', color: COLORS.usedCpu, kind: 'line' },
                ]}
                ariaLabel="CPU"
                valueFormat={formatCores}
                yTicks={[0, 50]}
                yFormat={(value) => String(Math.round(value))}
              />
            </div>
          </ChartCard>

          <ChartCard
            title="Memory"
            legend={[
              { color: COLORS.usedMemory, label: 'Used' },
              { color: COLORS.request, label: 'Request' },
            ]}
          >
            <div className="relative">
              <TimeSeriesChart
                data={memorySeries}
                series={[
                  { key: 'request', label: 'Request', color: COLORS.request, kind: 'area', fillOpacity: 0.14 },
                  { key: 'used', label: 'Used', color: COLORS.usedMemory, kind: 'line' },
                ]}
                ariaLabel="Memory"
                valueFormat={formatGiB}
                yTicks={[0, 500]}
              />
            </div>
          </ChartCard>

          <ChartCard
            title="Network"
            legend={[
              { color: COLORS.egress, label: 'Egress' },
              { color: COLORS.ingress, label: 'Ingress' },
            ]}
          >
            <div className="relative">
              <TimeSeriesChart
                data={networkSeries}
                series={[
                  { key: 'egress', label: 'Egress', color: COLORS.egress, kind: 'area', fillOpacity: 0.16 },
                  { key: 'ingress', label: 'Ingress', color: COLORS.ingress, kind: 'bar' },
                ]}
                ariaLabel="Network"
                valueFormat={formatRate}
                yTicks={[0, 200]}
                yFormat={(value) => `${value}%`}
              />
            </div>
          </ChartCard>

          <ChartCard
            title="Task Registry State"
            badge="Internal"
            legend={[
              { color: COLORS.slots, label: 'Max Green or Init Slots' },
              { color: COLORS.p90, label: 'Max Target Slots' },
            ]}
          >
            <div className="relative">
              <TimeSeriesChart
                data={taskRegistrySeries}
                series={[
                  { key: 'green', label: 'Max Green or Init Slots', color: COLORS.slots, kind: 'area', fillOpacity: 0.16 },
                  { key: 'target', label: 'Max Target Slots', color: COLORS.p90, kind: 'line' },
                ]}
                ariaLabel="Task registry state"
                valueFormat={(value) => value.toFixed(0)}
                yTicks={[0, 50]}
              />
            </div>
          </ChartCard>

          <ChartCard
            title="Pending calls"
            legend={[
              { color: COLORS.pending, label: 'Average' },
              { color: COLORS.pending, label: 'Maximum', hollow: true },
            ]}
          >
            <div className="relative">
              <TimeSeriesChart
                data={pendingCallsSeries}
                series={[
                  { key: 'average', label: 'Average', color: COLORS.pending, kind: 'area', fillOpacity: 0.14 },
                  { key: 'maximum', label: 'Maximum', color: COLORS.p90, kind: 'line', strokeWidth: 1.2 },
                ]}
                ariaLabel="Pending calls"
                valueFormat={(value) => `${value.toFixed(2)} calls`}
                yTicks={[0, 10, 20]}
              />
            </div>
          </ChartCard>

          <ChartCard
            title="Running calls"
            legend={[
              { color: COLORS.running, label: 'Average' },
              { color: COLORS.p90, label: 'Maximum' },
            ]}
          >
            <div className="relative">
              <TimeSeriesChart
                data={runningCallsSeries}
                series={[
                  { key: 'average', label: 'Average', color: COLORS.running, kind: 'area', fillOpacity: 0.16 },
                  { key: 'maximum', label: 'Maximum', color: COLORS.p90, kind: 'line' },
                ]}
                ariaLabel="Running calls"
                valueFormat={(value) => `${value.toFixed(2)} calls`}
                yTicks={[0, 500]}
              />
            </div>
          </ChartCard>

          <ChartCard
            title="Execution time"
            legend={[
              { color: COLORS.p50, label: 'p50' },
              { color: COLORS.p90, label: 'p90' },
            ]}
          >
            <div className="relative">
              <TimeSeriesChart
                data={executionTimeSeries}
                series={[
                  { key: 'p50', label: 'p50', color: COLORS.p50, kind: 'line' },
                  { key: 'p90', label: 'p90', color: COLORS.p90, kind: 'line' },
                ]}
                ariaLabel="Execution time"
                yFormat={formatDuration}
                valueFormat={formatDuration}
                yTicks={[0, 3.55 * 3600]}
                domainMax={6.2 * 3600}
              />
            </div>
          </ChartCard>
        </ChartGrid>

        <ChartCard title="Execution time (percentile vs. secs)">
          <PercentileChart rows={executionPercentiles} ariaLabel="Execution time percentiles" />
        </ChartCard>
      </PageBody>
    </PageShell>
  )
}
