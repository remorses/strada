'use client'

import {
  ChevronDownIcon,
  CopyIcon,
  InfoIcon,
  Maximize2Icon,
  SearchIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'spiceflow/react'
import { cn } from '../lib/utils.ts'
import { Button } from './ui/button.tsx'

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

export function TimeRangeBar() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm">
        <span className="size-2 rounded-full bg-success" />
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium">1h</span>
        <span>Sep 10, 4:05 PM – now</span>
        <span className="ml-2 flex items-center gap-1 text-muted-foreground">
          EDT
          <ChevronDownIcon className="size-3.5" />
        </span>
      </div>
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

export function ShowDeploymentsToggle() {
  return (
    <label className="ml-auto flex cursor-pointer items-center gap-2 text-sm">
      <span className="relative h-5 w-9 rounded-full bg-success">
        <span className="absolute top-0.5 right-0.5 size-4 rounded-full bg-card shadow-sm" />
      </span>
      Show Deployments
    </label>
  )
}

export function MetricTabs({
  items,
  active,
}: {
  items: { href: string; label: string; badge?: string; badgeTone?: 'destructive' | 'info'; badgeOnly?: boolean }[]
  active: string
}) {
  return (
    <div className="flex items-center gap-5 border-b border-border text-sm">
      {items.map((item) => (
        <Link
          key={item.label}
          href={item.href}
          className={cn(
            'relative -mb-px flex items-center gap-2 pb-2.5 text-muted-foreground',
            active === item.label && 'text-foreground',
          )}
        >
          {!item.badgeOnly && item.label}
          {item.badge && (
            <span
              className={cn(
                'rounded-full px-1.5 py-0.5 text-[11px] font-medium',
                item.badgeTone === 'destructive' && 'bg-destructive/10 text-destructive',
                item.badgeTone === 'info' && 'bg-violet-100 text-violet-700',
              )}
            >
              {item.badge}
            </span>
          )}
          {active === item.label && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-success" />}
        </Link>
      ))}
    </div>
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
