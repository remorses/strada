'use client'

import { ChartCard, KpiCard, MetricTabs, TimeRangeBar } from '../components/chrome.tsx'
import { SettingsPage, SettingsShell } from '../components/settings-shell.tsx'
import { SETTINGS_NAV } from '../lib/settings-nav.tsx'
import { ChartGrid, TimeSeriesChart } from '../components/charts.tsx'
import { COLORS } from '../lib/chart-colors.ts'
import {
  sandboxCpu,
  sandboxCpuPer,
  sandboxCreated,
  sandboxLifetime,
  sandboxMemory,
  sandboxMemoryPer,
  sandboxNetwork,
  sandboxSeries,
  timeToStarted,
} from '../lib/metrics-data.ts'
import { formatCompactDuration, formatCores, formatGiB } from '../lib/utils.ts'

export function SandboxesPage() {
  return (
    <SettingsShell items={SETTINGS_NAV}>
      <SettingsPage>
        <TimeRangeBar />

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <KpiCard label="Concurrent sandboxes" value="686" live />
          <KpiCard label="Total sandboxes created" value="159" />
          <KpiCard label="Average sandboxes created per second" value="0.044" />
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="text-center text-sm font-medium">Sandboxes created</h2>
          <TimeSeriesChart
            data={sandboxCreated}
            series={[{ key: 'created', label: 'created', color: COLORS.pending, kind: 'bar' }]}
            ariaLabel="Sandboxes created"
            valueFormat={(value) => value.toFixed(0)}
            height={140}
            yTicks={[0, 50]}
            margin={{ top: 8, right: 16, bottom: 24, left: 34 }}
          />
        </section>

        <MetricTabs active="Metrics" items={[{ label: 'Metrics' }, { label: 'Sandboxes' }]} />

        <ChartGrid>
          <ChartCard
            title="Sandboxes"
            legend={[
              { color: COLORS.live, label: 'Live' },
              { color: COLORS.live, label: 'Total' },
            ]}
          >
            <div className="relative">
              <TimeSeriesChart
                data={sandboxSeries}
                series={[
                  { key: 'live', label: 'Live', color: COLORS.live, kind: 'area', fillOpacity: 0.1 },
                  { key: 'total', label: 'Total', color: COLORS.live, kind: 'line' },
                ]}
                ariaLabel="Sandboxes"
                valueFormat={(value) => `${value.toFixed(0)} sandboxes`}
                yTicks={[0, 500]}
              />
            </div>
          </ChartCard>

          <ChartCard
            title="Lifetime"
            legend={[
              { color: COLORS.p50, label: 'p50' },
              { color: COLORS.p90, label: 'p90' },
            ]}
          >
            <div className="relative">
              <TimeSeriesChart
                data={sandboxLifetime}
                series={[
                  { key: 'p50', label: 'p50', color: COLORS.p50, kind: 'line' },
                  { key: 'p90', label: 'p90', color: COLORS.p90, kind: 'line' },
                ]}
                ariaLabel="Sandbox lifetime"
                yFormat={formatCompactDuration}
                valueFormat={formatCompactDuration}
                yTicks={[0, 2.78 * 3600, 5.55 * 3600]}
                domainMax={6.4 * 3600}
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
                data={sandboxCpu}
                series={[
                  { key: 'request', label: 'Request', color: COLORS.request, kind: 'area', fillOpacity: 0.14 },
                  { key: 'used', label: 'Used', color: COLORS.usedCpu, kind: 'line' },
                ]}
                ariaLabel="Sandbox CPU"
                valueFormat={formatCores}
                yTicks={[0, 50]}
              />
            </div>
          </ChartCard>

          <ChartCard
            title="CPU Per Sandbox"
            info
            legend={[
              { color: COLORS.usedCpu, label: 'p50' },
              { color: COLORS.usedCpu, label: 'p75' },
              { color: COLORS.request, label: 'Request' },
            ]}
          >
            <div className="relative">
              <TimeSeriesChart
                data={sandboxCpuPer}
                series={[
                  { key: 'request', label: 'Request', color: COLORS.request, kind: 'line', strokeWidth: 1.2 },
                  { key: 'p75', label: 'p75', color: COLORS.usedCpu, kind: 'line' },
                  { key: 'p50', label: 'p50', color: COLORS.p50, kind: 'line' },
                ]}
                ariaLabel="CPU per sandbox"
                valueFormat={formatCores}
                yTicks={[0, 0.05, 0.1]}
                yFormat={(value) => value.toFixed(2)}
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
                data={sandboxMemory}
                series={[
                  { key: 'request', label: 'Request', color: COLORS.request, kind: 'area', fillOpacity: 0.14 },
                  { key: 'used', label: 'Used', color: COLORS.usedMemory, kind: 'line' },
                ]}
                ariaLabel="Sandbox memory"
                valueFormat={formatGiB}
                yTicks={[0, 500]}
              />
            </div>
          </ChartCard>

          <ChartCard title="Memory Per Sandbox" info>
            <div className="relative">
              <TimeSeriesChart
                data={sandboxMemoryPer}
                series={[
                  { key: 'request', label: 'Request', color: COLORS.request, kind: 'line', strokeWidth: 1.2 },
                  { key: 'p99', label: 'p99', color: COLORS.p90, kind: 'line' },
                  { key: 'p95', label: 'p95', color: COLORS.usedMemory, kind: 'line' },
                  { key: 'p90', label: 'p90', color: COLORS.p50, kind: 'line' },
                ]}
                ariaLabel="Memory per sandbox"
                valueFormat={(value) => `${value.toFixed(2)} MB`}
                yTicks={[0, 51, 102]}
                yFormat={(value) => `${Math.round(value)}M`}
              />
            </div>
          </ChartCard>

          <ChartCard title="Time to Started" info>
            <div className="relative">
              <TimeSeriesChart
                data={timeToStarted}
                series={[
                  { key: 'p90', label: 'p90', color: COLORS.p90, kind: 'line' },
                  { key: 'p50', label: 'p50', color: COLORS.p50, kind: 'line' },
                ]}
                ariaLabel="Time to started"
                valueFormat={(value) => `${value.toFixed(2)}s`}
                yTicks={[0, 2]}
                domainMax={2.2}
                yFormat={(value) => `${value.toFixed(0)}s`}
              />
            </div>
          </ChartCard>

          <ChartCard title="Network">
            <TimeSeriesChart
              data={sandboxNetwork}
              series={[
                { key: 'egress', label: 'Egress', color: COLORS.egress, kind: 'line' },
                { key: 'ingress', label: 'Ingress', color: COLORS.ingress, kind: 'line' },
              ]}
              ariaLabel="Sandbox network"
              valueFormat={(value) => `${value.toFixed(2)}%`}
              yTicks={[0, 2]}
              yFormat={(value) => `${value}%`}
              height={120}
            />
          </ChartCard>
        </ChartGrid>
      </SettingsPage>
    </SettingsShell>
  )
}
