'use client'

import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import { AppShell, SettingsPage } from '../components/app-shell.tsx'
import { TimeSeriesChart } from '../components/charts.tsx'
import { Legend } from '../components/chrome.tsx'
import { Button } from '../components/ui/button.tsx'
import { COLORS } from '../lib/chart-colors.ts'
import { ingestDaily } from '../lib/mock-data.ts'
import { formatCompact, formatMoney } from '../lib/utils.ts'

const BILLING_CYCLES = ['Jul 23 – Aug 23, 2026', 'Aug 23 – Sep 23, 2026', 'Sep 23 – Oct 23, 2026']

const SIGNALS = [
  { key: 'spans', label: 'Spans', color: COLORS.primary, pricePerMillion: 0.3 },
  { key: 'logs', label: 'Logs', color: COLORS.secondary, pricePerMillion: 0.2 },
  { key: 'errors', label: 'Errors', color: COLORS.error, pricePerMillion: 1 },
] as const

export function UsagePage() {
  const [cycleIndex, setCycleIndex] = useState(1)
  const totals = SIGNALS.map((signal) => {
    const events = ingestDaily.reduce((sum, point) => sum + Number(point[signal.key]), 0)
    return { ...signal, events, cost: (events / 1_000_000) * signal.pricePerMillion }
  })
  const totalCost = totals.reduce((sum, item) => sum + item.cost, 0)

  return (
    <AppShell>
      <SettingsPage>
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <div className="text-sm text-muted-foreground">Ingest this cycle</div>
            <div className="text-[40px] leading-none font-semibold tracking-tight">{formatMoney(totalCost)}</div>
          </div>
          <div className="flex h-9 items-center gap-2 text-sm">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Previous cycle"
              disabled={cycleIndex === 0}
              onClick={() => setCycleIndex((index) => Math.max(0, index - 1))}
            >
              <ChevronLeftIcon />
            </Button>
            <span className="tabular-nums">{BILLING_CYCLES[cycleIndex]}</span>
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

        <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-medium">Events ingested per day</h2>
            <Legend items={SIGNALS.map((signal) => ({ color: signal.color, label: signal.label }))} />
          </div>
          <TimeSeriesChart
            data={ingestDaily}
            series={SIGNALS.map((signal) => ({ key: signal.key, label: signal.label, color: signal.color, kind: 'bar' as const }))}
            stacked
            ariaLabel="Events ingested per day"
            yFormat={formatCompact}
            valueFormat={(value) => value.toLocaleString()}
            height={220}
          />
          <div className="flex flex-col gap-2 border-t border-border pt-3 text-sm">
            {totals.map((item) => (
              <div key={item.key} className="grid grid-cols-[1fr_120px_100px] items-center">
                <span className="flex items-center gap-2">
                  <span className="size-2.5 rounded-[2px]" style={{ background: item.color }} />
                  {item.label}
                  <span className="text-xs text-muted-foreground">{formatMoney(item.pricePerMillion)} / M</span>
                </span>
                <span className="text-right text-muted-foreground tabular-nums">{formatCompact(item.events)}</span>
                <span className="text-right tabular-nums">{formatMoney(item.cost)}</span>
              </div>
            ))}
            <div className="grid grid-cols-[1fr_100px] border-t border-border pt-2 font-medium">
              <span>Total</span>
              <span className="text-right tabular-nums">{formatMoney(totalCost)}</span>
            </div>
          </div>
        </section>
      </SettingsPage>
    </AppShell>
  )
}
