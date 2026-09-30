'use client'

// Small presentational pieces shared by the dashboard pages: status dots,
// pills, inline bars, uptime strips, rank cards, and the side detail panel
// (the web version of the TUI's List.Item.Detail).

import { XIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { CheckStatus, RankRow, Severity } from '../lib/mock-data.ts'
import { cn, formatCompact, formatPercent } from '../lib/utils.ts'
import { findUser } from '../lib/workspace.tsx'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar.tsx'
import { Button } from './ui/button.tsx'

// Rounded so SSR and browser serialize the same inline style (avoids hydration mismatches).
function pct(value: number) {
  return `${Math.round(value * 10) / 10}%`
}

export type Tone = 'destructive' | 'warning' | 'success' | 'info' | 'muted'

const DOT_TONE: Record<Tone, string> = {
  destructive: 'bg-destructive',
  warning: 'bg-warning',
  success: 'bg-success',
  info: 'bg-info',
  muted: 'bg-muted-foreground/50',
}

const TEXT_TONE: Record<Tone, string> = {
  destructive: 'text-destructive',
  warning: 'text-warning',
  success: 'text-success',
  info: 'text-info',
  muted: 'text-muted-foreground',
}

export function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', DOT_TONE[tone], className)} />
}

export function Pill({ children, tone, className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2 text-xs whitespace-nowrap text-muted-foreground',
        className,
      )}
    >
      {tone ? <Dot tone={tone} className="size-1.5" /> : null}
      {children}
    </span>
  )
}

export const SEVERITY_TONE: Record<Severity, Tone> = {
  DEBUG: 'muted',
  INFO: 'info',
  WARN: 'warning',
  ERROR: 'destructive',
  FATAL: 'destructive',
}

export function SeverityLabel({ severity }: { severity: Severity }) {
  return (
    <span className={cn('inline-flex w-12 items-center gap-1.5 font-mono text-[11px] font-medium', TEXT_TONE[SEVERITY_TONE[severity]])}>
      {severity}
    </span>
  )
}

export const CHECK_TONE: Record<CheckStatus, Tone> = { up: 'success', degraded: 'warning', down: 'destructive' }

// Pulsing ring for live statuses (checks, active issues).
export function StatusRing({ tone }: { tone: Tone }) {
  return (
    <span className="relative flex size-2.5 shrink-0 items-center justify-center">
      {tone === 'destructive' ? <span className={cn('absolute size-full animate-ping rounded-full opacity-60', DOT_TONE[tone])} /> : null}
      <span className={cn('relative size-2 rounded-full', DOT_TONE[tone])} />
    </span>
  )
}

// Sentry-style tiny bar sparkline for table rows.
export function MiniBars({ values, tone = 'muted', className }: { values: number[]; tone?: Tone; className?: string }) {
  const max = Math.max(1, ...values)
  return (
    <span className={cn('flex h-5 w-[72px] items-end gap-px', className)}>
      {values.map((value, index) => (
        <span
          key={index}
          className={cn('flex-1 rounded-[1px]', value > 0 ? DOT_TONE[tone] : 'bg-border')}
          style={{ height: pct(value > 0 ? Math.max(12, (value / max) * 100) : 8), opacity: value > 0 ? 0.85 : 1 }}
        />
      ))}
    </span>
  )
}

export function ShareBar({ value, tone = 'info' }: { value: number; tone?: Tone }) {
  return (
    <span className="inline-flex h-1.5 w-16 overflow-hidden rounded-full bg-muted">
      <span className={cn('block h-full rounded-full', DOT_TONE[tone])} style={{ width: pct(value > 0 ? Math.max(3, value * 100) : 0) }} />
    </span>
  )
}

// Horizontal bar proportional to max, used for durations in trace lists.
export function DurationBar({ value, max, label, tone = 'info' }: { value: number; max: number; label: string; tone?: Tone }) {
  return (
    <span className="flex w-full items-center gap-2">
      <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span className={cn('absolute inset-y-0 left-0 rounded-full', DOT_TONE[tone])} style={{ width: pct(Math.max(2, (value / max) * 100)) }} />
      </span>
      <span className="w-14 text-right tabular-nums">{label}</span>
    </span>
  )
}

function uptimeTone(ratio: number): Tone {
  if (ratio >= 0.999) return 'success'
  if (ratio >= 0.97) return 'warning'
  return 'destructive'
}

// Status-page style strip, one bar per day.
export function UptimeStrip({ days, className }: { days: number[]; className?: string }) {
  return (
    <span className={cn('flex h-6 items-stretch gap-[2px]', className)}>
      {days.map((ratio, index) => (
        <span
          key={index}
          title={`${days.length - index - 1}d ago · ${formatPercent(ratio, 2)}`}
          className={cn('w-[3px] rounded-[1px] hover:opacity-60', DOT_TONE[uptimeTone(ratio)])}
        />
      ))}
    </span>
  )
}

export function UserAvatar({ userId, className }: { userId?: string; className?: string }) {
  const user = findUser(userId)
  if (!user) return <span className={cn('inline-block size-5 rounded-full border border-dashed border-muted-foreground/50', className)} />
  return (
    <Avatar className={cn('size-5', className)}>
      <AvatarImage src={user.avatarSrc} alt={user.name} />
      <AvatarFallback>{user.name.slice(0, 1)}</AvatarFallback>
    </Avatar>
  )
}

// Plausible / Vercel Analytics style ranked list with share bars behind rows.
export function RankCard({
  title,
  rows,
  valueLabel,
  secondaryLabel,
  mono,
}: {
  title: string
  rows: RankRow[]
  valueLabel: string
  secondaryLabel?: string
  mono?: boolean
}) {
  const max = Math.max(1, ...rows.map((row) => row.value))
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1 pb-1 text-xs text-muted-foreground">
        <h2 className="text-[13px] font-medium text-foreground">{title}</h2>
        <span className="ml-auto">{valueLabel}</span>
        {secondaryLabel ? <span className="w-16 text-right">{secondaryLabel}</span> : null}
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <div key={row.name} className="group relative flex h-8 items-center gap-2 px-2 text-[13px]">
            <span
              className="absolute inset-y-0 left-0 rounded-md bg-info/10 transition-colors group-hover:bg-info/20"
              style={{ width: pct((row.value / max) * 100) }}
            />
            {row.icon ? (
              <span className="relative flex size-4 shrink-0 items-center justify-center text-[11px] font-semibold text-muted-foreground">
                {row.icon}
              </span>
            ) : null}
            <span className={cn('relative min-w-0 flex-1 truncate', mono && 'font-mono text-xs')}>{row.name}</span>
            <span className="relative tabular-nums">{formatCompact(row.value)}</span>
            {row.secondary !== undefined ? (
              <span className="relative w-16 text-right text-muted-foreground tabular-nums">{formatCompact(row.secondary)}</span>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  )
}

// Key/value rows, mirrors List.Item.Detail.Metadata.Label in the TUI.
export function MetaList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[112px_1fr] gap-x-3 gap-y-2 text-[13px]">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className="min-w-0 truncate">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function DetailPanel({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <aside className="sticky top-6 flex max-h-[calc(100dvh-48px)] w-[380px] shrink-0 flex-col overflow-hidden">
      <div className="flex items-start gap-2 pb-3">
        <div className="min-w-0 flex-1 text-[13px] font-medium">{title}</div>
        <Button size="icon-xs" variant="ghost" aria-label="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <div className="flex flex-col gap-5 overflow-y-auto">{children}</div>
    </aside>
  )
}

export function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-xs', className)}>{children}</span>
}
