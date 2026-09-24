'use client'

import { AppShell, DashboardPage } from '../components/app-shell.tsx'
import { TimeSeriesChart } from '../components/charts.tsx'
import { ChartCard, KpiCard, KpiRow, PageHeader, QueryBar } from '../components/chrome.tsx'
import { Pill, RankCard } from '../components/widgets.tsx'
import { COLORS } from '../lib/chart-colors.ts'
import {
  ANALYTICS_KPIS,
  BROWSERS,
  COUNTRIES,
  CUSTOM_EVENTS,
  DEVICES,
  REFERRERS,
  TOP_PAGES,
  visitorsDaily,
} from '../lib/mock-data.ts'
import { formatCompact } from '../lib/utils.ts'

export function AnalyticsPage() {
  return (
    <AppShell>
      <DashboardPage>
        <PageHeader
          title="Analytics"
          meta="strada.sh · last 30 days"
          actions={<Pill tone="success">38 visitors online</Pill>}
        />
        <QueryBar
          placeholder="visitors from hacker news last week…"
          examples={['mobile visitors from Germany', 'only /docs pages', 'last 7 days']}
          sql="Date >= today() - INTERVAL 7 DAY AND Referrer = 'news.ycombinator.com'"
        />

        <KpiRow>
          {ANALYTICS_KPIS.map((kpi) => (
            <KpiCard key={kpi.label} label={kpi.label} value={kpi.value} delta={kpi.delta} lowerIsBetter={kpi.label === 'Bounce rate'} />
          ))}
        </KpiRow>

        <ChartCard
          title="Traffic"
          legend={[
            { color: COLORS.primary, label: 'Visitors' },
            { color: COLORS.secondary, label: 'Pageviews' },
          ]}
        >
          <TimeSeriesChart
            data={visitorsDaily}
            series={[
              { key: 'pageviews', label: 'Pageviews', color: COLORS.secondary, kind: 'bar', fillOpacity: 0.7 },
              { key: 'visitors', label: 'Visitors', color: COLORS.primary, kind: 'area', fillOpacity: 0.14 },
            ]}
            ariaLabel="Visitors and pageviews"
            yFormat={formatCompact}
            valueFormat={(value) => value.toLocaleString()}
            height={220}
          />
        </ChartCard>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <RankCard title="Top pages" rows={TOP_PAGES} valueLabel="Visitors" mono />
          <RankCard title="Referrers" rows={REFERRERS} valueLabel="Visitors" />
          <RankCard title="Countries" rows={COUNTRIES} valueLabel="Visitors" />
          <RankCard title="Browsers" rows={BROWSERS} valueLabel="Visitors" />
          <RankCard title="Devices" rows={DEVICES} valueLabel="Visitors" />
          <RankCard title="Custom events" rows={CUSTOM_EVENTS} valueLabel="Count" secondaryLabel="Sessions" mono />
        </div>
      </DashboardPage>
    </AppShell>
  )
}
