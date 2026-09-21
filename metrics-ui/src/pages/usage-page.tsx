'use client'

import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import { ChartCard } from '../components/chrome.tsx'
import { SettingsPage, SettingsShell } from '../components/settings-shell.tsx'
import { SETTINGS_NAV } from '../lib/settings-nav.tsx'
import { CategoryBarChart, TimeSeriesChart } from '../components/charts.tsx'
import { COLORS } from '../lib/chart-colors.ts'
import { Button } from '../components/ui/button.tsx'
import { Tabs, TabsList, TabsTab } from '../components/ui/tabs.tsx'
import {
  cycleUsage,
  functionCosts,
  lastHourUsage,
} from '../lib/metrics-data.ts'
import { formatMoney } from '../lib/utils.ts'

const BILLING_CYCLES = [
  'Jul 1 – Aug 1, 2026',
  'Aug 1 – Sep 1, 2026',
  'Sep 1 – Oct 1, 2026',
]

export function UsagePage() {
  const [cycleIndex, setCycleIndex] = useState(BILLING_CYCLES.length - 1)
  const [usageWindow, setUsageWindow] = useState('1h')
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
    <SettingsShell items={SETTINGS_NAV}>
      <SettingsPage>
        <div className="flex items-start justify-end gap-4">
          <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Previous cycle"
              disabled={cycleIndex === 0}
              onClick={() => setCycleIndex((index) => Math.max(0, index - 1))}
            >
              <ChevronLeftIcon />
            </Button>
            <span className="tabular-nums">Billing Cycle: {BILLING_CYCLES[cycleIndex]}</span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Next cycle"
              disabled={cycleIndex === BILLING_CYCLES.length - 1}
              onClick={() => setCycleIndex((index) => Math.min(BILLING_CYCLES.length - 1, index + 1))}
            >
              <ChevronRightIcon />
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="text-sm text-muted-foreground">Total Usage</div>
          <div className="text-[40px] font-semibold tracking-tight">{formatMoney(6715.12)}</div>
        </div>

        <section className="flex flex-col gap-4 overflow-hidden bg-background p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-medium">
              {usageWindow === '1h' ? 'Last Hour Usage: $28.90' : 'Last 24h Usage: $694.80'}
            </h2>
            <Tabs value={usageWindow} onValueChange={(next) => setUsageWindow(String(next))}>
              <TabsList>
                <TabsTab value="1h">Last hour</TabsTab>
                <TabsTab value="24h">Last 24h</TabsTab>
              </TabsList>
            </Tabs>
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

        <section className="flex flex-col gap-4 overflow-hidden bg-background p-5">
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

        <section className="flex flex-col gap-3 bg-background p-5">
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
      </SettingsPage>
    </SettingsShell>
  )
}
