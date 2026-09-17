'use client'

import { CopyIcon, InfoIcon, Maximize2Icon, SearchIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'spiceflow/react'
import { cn } from '../lib/utils.ts'
import { Button } from './ui/button.tsx'
import { NativeSelect, NativeSelectOption } from './ui/native-select.tsx'
import { Tabs, TabsList, TabsTab } from './ui/tabs.tsx'

export function PageShell({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-background text-foreground">{children}</div>
}

export function PageBody({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex w-full max-w-[var(--page-max-width)] flex-col gap-5 px-8 py-6">{children}</div>
}

export function Breadcrumbs({ items }: { items: { href?: string; label: string }[] }) {
  return (
    <nav className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
      {items.map((item, index) => (
        <span key={item.label} className="flex items-center gap-1.5">
          {index > 0 && <span>/</span>}
          {item.href ? (
            <Link href={item.href} className="hover:text-foreground">
              {item.label}
            </Link>
          ) : (
            <span>{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  )
}

export function PageTitle({ children, copied }: { children: ReactNode; copied?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <h1 className="text-[28px] font-semibold tracking-tight">{children}</h1>
      {copied !== undefined && (
        <Button size="icon-sm" variant="ghost" aria-label="Copy">
          <CopyIcon />
        </Button>
      )}
    </div>
  )
}

export const TIME_RANGES = [
  { value: '15m', label: 'Last 15 minutes' },
  { value: '1h', label: 'Last hour' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
]

export function TimeRangeBar() {
  const [range, setRange] = useState('1h')
  return (
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect value={range} onChange={(event) => setRange(event.target.value)} aria-label="Time range">
        {TIME_RANGES.map((item) => (
          <NativeSelectOption key={item.value} value={item.value}>
            {item.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Button size="icon" variant="outline" aria-label="Search">
        <SearchIcon />
      </Button>
    </div>
  )
}

export function StatusPills({
  items,
}: {
  items: { label: string; value: string; tone?: 'success' | 'muted' }[]
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {items.map((item) => (
        <div
          key={item.label}
          className="flex h-8 items-center gap-2 rounded-full border border-border bg-card px-3 text-[13px]"
        >
          <span className="text-muted-foreground">{item.label}:</span>
          {item.tone === 'success' && <span className="size-1.5 rounded-full bg-success" />}
          <span className="font-medium">{item.value}</span>
        </div>
      ))}
    </div>
  )
}

export type MetricTabItem = {
  label: string
  badge?: string
  badgeTone?: 'destructive' | 'info'
  badgeOnly?: boolean
}

export function MetricTabs({ items, active }: { items: MetricTabItem[]; active: string }) {
  const [value, setValue] = useState(active)
  return (
    <Tabs value={value} onValueChange={(next) => setValue(String(next))}>
      <TabsList variant="line">
        {items.map((item) => (
          <TabsTab key={item.label} value={item.label}>
            {!item.badgeOnly && item.label}
            {item.badge && (
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[11px] font-medium',
                  item.badgeTone === 'destructive' && 'bg-destructive/10 text-destructive',
                  item.badgeTone === 'info' && 'bg-info/10 text-info',
                )}
              >
                {item.badge}
              </span>
            )}
          </TabsTab>
        ))}
      </TabsList>
    </Tabs>
  )
}

export function ChartCard({
  title,
  badge,
  expand,
  info,
  legend,
  children,
}: {
  title: string
  badge?: string
  expand?: boolean
  info?: boolean
  legend?: { color: string; label: string; hollow?: boolean }[]
  children: ReactNode
}) {
  return (
    <section className="relative flex flex-col gap-2 overflow-hidden bg-background px-4 pt-3 pb-3">
      <div className="flex min-h-5 items-center justify-center gap-1.5">
        <h2 className="text-[15px] font-medium">{title}</h2>
        {badge && (
          <span className="rounded-full bg-orange-50 px-1.5 py-0.5 text-[10px] font-medium text-orange-700">
            {badge}
          </span>
        )}
        {info && <InfoIcon className="size-3.5 text-foreground" />}
      </div>
      {expand && (
        <Button className="absolute top-2 right-2" size="icon-sm" variant="ghost" aria-label="Expand">
          <Maximize2Icon />
        </Button>
      )}
      {children}
      {legend && (
        <div className="flex min-h-4 flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
          {legend.map((item) => (
            <span key={item.label} className="flex items-center gap-1.5">
              <span
                className={cn('size-2.5 rounded-[2px]', item.hollow && 'border bg-transparent')}
                style={{ background: item.hollow ? undefined : item.color, borderColor: item.color }}
              />
              {item.label}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

export function KpiCard({
  label,
  value,
  live,
}: {
  label: string
  value: string
  live?: boolean
}) {
  return (
    <div className="flex flex-col gap-2 bg-background px-5 py-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {label}
        {live && (
          <span className="ml-auto flex items-center gap-1.5 text-xs">
            <span className="size-1.5 rounded-full bg-success" />
            Live
          </span>
        )}
      </div>
      <div className="text-[32px] font-semibold tracking-tight">{value}</div>
    </div>
  )
}

export function EmptyReadyState() {
  return (
    <div className="flex h-[164px] flex-col items-center justify-center gap-3 text-center text-balance">
      <p className="text-sm text-muted-foreground">Track how long sandboxes take to become ready.</p>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-md border border-success/30 bg-success/10 px-3 py-1.5 text-sm text-success"
      >
        Try readiness probes
        <span>↗</span>
      </button>
    </div>
  )
}
