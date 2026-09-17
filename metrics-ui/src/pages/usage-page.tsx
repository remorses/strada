'use client'

import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import {
  Breadcrumbs,
  ChartCard,
  PageBody,
  PageShell,
  PageTitle,
} from '../components/chrome.tsx'
import { CategoryBarChart, TimeSeriesChart } from '../components/charts.tsx'
import { COLORS } from '../lib/chart-colors.ts'
import { Button } from '../components/ui/button.tsx'
import {
  APP_NAME,
  cycleUsage,
  functionCosts,
  lastHourUsage,
} from '../lib/metrics-data.ts'
import { formatMoney } from '../lib/utils.ts'

export function UsagePage() {
  const stackedHour = lastHourUsage.reduce<
    { time: Date; cpu: number; memory: number }[]
  >((rows, item) => {
    const existing = rows.find((row) => row.time.getTime() === item.time.getTime())
    if (existing) {
      if (item.series === 'CPU') existing.cpu = item.value
      else existing.memory = item.value
      return rows
    }
    rows.push({
      time: item.time,
      cpu: item.series === 'CPU' ? item.value : 0,
      memory: item.series === 'Memory' ? item.value : 0,
    })
    return rows
  }, [])

  return (
    <PageShell>
      <PageBody>
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Breadcrumbs items={[{ label: 'Apps', href: '/sandboxes' }, { label: APP_NAME }]} />
            <PageTitle>Usage</PageTitle>
          </div>
          <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm">
            <Button size="icon-sm" variant="ghost" aria-label="Previous cycle">
              <ChevronLeftIcon />
            </Button>
            <span>Billing Cycle: Sep 1 – Oct 1, 2026</span>
            <Button size="icon-sm" variant="ghost" aria-label="Next cycle">
              <ChevronRightIcon />
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="text-sm text-muted-foreground">Total Usage</div>
          <div className="text-[40px] font-semibold tracking-tight">{formatMoney(6715.12)}</div>
        </div>

        <section className="flex flex-col gap-4 overflow-hidden rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-medium">Last Hour Usage: $28.90</h2>
            <div className="flex rounded-md border border-border text-xs">
              <span className="rounded-l-md bg-muted px-2.5 py-1.5 font-medium">Last hour</span>
              <span className="px-2.5 py-1.5 text-muted-foreground">Last 24h</span>
            </div>
          </div>
          <div className="relative">
            <TimeSeriesChart
              data={stackedHour}
              series={[
                { key: 'cpu', label: 'CPU', color: COLORS.usageCpu, kind: 'bar' },
                { key: 'memory', label: 'Memory', color: COLORS.usageMemory, kind: 'bar' },
              ]}
              stacked
              ariaLabel="Last hour usage"
              valueFormat={formatMoney}
              height={220}
              yTicks={[0, 0.1, 0.2, 0.3, 0.4, 0.5]}
              yFormat={(value) => formatMoney(value)}
            />
          </div>
        </section>

        <section className="flex flex-col gap-4 overflow-hidden rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <h2 className="relative z-10 text-[15px] font-medium">Cycle Resource Breakdown</h2>
            <button type="button" className="relative z-10 text-sm text-muted-foreground hover:text-foreground">
              View all rates →
            </button>
          </div>
          <div className="relative overflow-hidden">
            <CategoryBarChart
              rows={cycleUsage.map((row) => ({ x: row.day, series: row.series, value: row.value }))}
              ariaLabel="Cycle resource breakdown"
              height={240}
              yTicks={[0, 200, 400, 600]}
              domainMax={780}
              cursorX="Thu 10"
              yFormat={formatMoney}
            />
          </div>
          <div className="flex flex-col gap-2 border-t border-border pt-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className="size-2.5 rounded-[2px]" style={{ background: COLORS.usageCpu }} />
                CPU
              </span>
              <span className="tabular-nums">{formatMoney(5743.72)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className="size-2.5 rounded-[2px]" style={{ background: COLORS.usageMemory }} />
                Memory
              </span>
              <span className="tabular-nums">{formatMoney(971.43)}</span>
            </div>
            <div className="flex items-center justify-between border-t border-border pt-2 font-medium">
              <span>Total</span>
              <span className="tabular-nums">{formatMoney(6715.14)}</span>
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
          <h2 className="text-[15px] font-medium">Functions</h2>
          <div className="flex flex-col gap-3 text-sm">
            {functionCosts.map((item) => (
              <div key={item.name} className="flex items-center justify-between">
                <span className="font-mono text-[13px]">{item.name}</span>
                <span className="tabular-nums">{formatMoney(item.amount)}</span>
              </div>
            ))}
          </div>
        </section>
      </PageBody>
    </PageShell>
  )
}
