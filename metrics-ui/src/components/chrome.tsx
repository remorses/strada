'use client'

import { ArrowDownRightIcon, ArrowUpRightIcon, CornerDownLeftIcon, InfoIcon, Maximize2Icon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn, formatPercent } from '../lib/utils.ts'
import { Button } from './ui/button.tsx'

export function PageHeader({ title, meta, actions }: { title: string; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
      {meta ? <div className="text-[13px] text-muted-foreground">{meta}</div> : null}
      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}

// The only filter UI: natural language that the backend turns into SQL.
// In this mockup, submitting just reveals the fake generated WHERE clause.
export function QueryBar({ placeholder, examples, sql }: { placeholder: string; examples: string[]; sql: string }) {
  const [text, setText] = useState('')
  const [submitted, setSubmitted] = useState('')

  return (
    <div className="flex flex-col gap-2">
      <form
        className="group flex h-10 items-center gap-2.5 rounded-xl border border-input bg-card px-3 transition-colors focus-within:border-ring/40 focus-within:ring-3 focus-within:ring-ring/10"
        onSubmit={(event) => {
          event.preventDefault()
          setSubmitted(text)
        }}
      >
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={placeholder}
          aria-label="Filter with natural language"
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <kbd className="flex h-5 items-center rounded border border-border px-1 text-muted-foreground">
          <CornerDownLeftIcon className="size-3" />
        </kbd>
      </form>
      <div className="flex min-h-5 flex-wrap items-center gap-1.5 px-1 text-xs text-muted-foreground">
        {submitted ? (
          <>
            <span className="rounded bg-muted px-1.5 py-0.5 font-medium">SQL</span>
            <code className="truncate font-mono text-[11px] text-foreground/80">WHERE {sql}</code>
          </>
        ) : (
          <>
            <span>Try</span>
            {examples.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => {
                  setText(example)
                  setSubmitted(example)
                }}
                className="rounded-full border border-border px-2 py-0.5 hover:bg-muted hover:text-foreground"
              >
                {example}
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

export function KpiCard({
  label,
  value,
  delta,
  lowerIsBetter,
  hint,
  live,
  tone,
}: {
  label: string
  value: string
  delta?: number
  lowerIsBetter?: boolean
  hint?: string
  live?: boolean
  tone?: 'destructive' | 'success'
}) {
  const good = delta === undefined ? true : lowerIsBetter ? delta <= 0 : delta >= 0
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        {label}
        {live && (
          <span className="ml-auto flex items-center gap-1.5 text-xs">
            <span className="size-1.5 animate-pulse rounded-full bg-success" />
            Live
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            'text-[26px] leading-none font-semibold tracking-tight tabular-nums',
            tone === 'destructive' && 'text-destructive',
            tone === 'success' && 'text-success',
          )}
        >
          {value}
        </span>
        {delta !== undefined ? (
          <span className={cn('flex items-center text-xs font-medium tabular-nums', good ? 'text-success' : 'text-destructive')}>
            {delta >= 0 ? <ArrowUpRightIcon className="size-3.5" /> : <ArrowDownRightIcon className="size-3.5" />}
            {formatPercent(Math.abs(delta))}
          </span>
        ) : null}
      </div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  )
}

export function KpiRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>
}

export function ChartCard({
  title,
  badge,
  expand,
  info,
  legend,
  actions,
  children,
  className,
}: {
  title: string
  badge?: string
  expand?: boolean
  info?: boolean
  legend?: { color: string; label: string; hollow?: boolean }[]
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('relative flex flex-col gap-2', className)}>
      <div className="flex min-h-6 items-center gap-1.5">
        <h2 className="text-[13px] font-medium">{title}</h2>
        {badge && (
          <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">{badge}</span>
        )}
        {info && <InfoIcon className="size-3.5 text-muted-foreground" />}
        <div className="ml-auto flex items-center gap-3">
          {legend && <Legend items={legend} />}
          {actions}
          {expand && (
            <Button size="icon-xs" variant="ghost" aria-label="Expand">
              <Maximize2Icon />
            </Button>
          )}
        </div>
      </div>
      {children}
    </section>
  )
}

export function Legend({ items }: { items: { color: string; label: string; hollow?: boolean }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5">
          <span
            className={cn('size-2 rounded-[2px]', item.hollow && 'border bg-transparent')}
            style={{ background: item.hollow ? undefined : item.color, borderColor: item.color }}
          />
          {item.label}
        </span>
      ))}
    </div>
  )
}

export function SectionTitle({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 px-1">
      <h2 className="text-[15px] font-medium">{children}</h2>
      {meta ? <span className="text-xs text-muted-foreground">{meta}</span> : null}
    </div>
  )
}
