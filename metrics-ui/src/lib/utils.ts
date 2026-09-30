import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { NOW } from './mock-data.ts'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const TIMEZONE = 'America/New_York'

function dateParts(date: Date, options: Intl.DateTimeFormatOptions) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, ...options }).formatToParts(date)
  return (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
}

export function formatClock(date: Date) {
  const part = dateParts(date, { hour: '2-digit', minute: '2-digit', hour12: true })
  return `${part('hour').padStart(2, '0')}:${part('minute')} ${part('dayPeriod')}`
}

export function formatDay(date: Date) {
  const part = dateParts(date, { month: 'short', day: 'numeric' })
  return `${part('month')} ${part('day')}`
}

// Daily ranges get "Sep 3" ticks, intraday ranges get "10 AM" / "10:30".
export function formatTickTime(date: Date, daily: boolean) {
  if (daily) return formatDay(date)
  const part = dateParts(date, { hour: 'numeric', minute: '2-digit', hour12: true })
  const hour = part('hour').padStart(2, '0')
  if (part('minute') === '00') return `${hour} ${part('dayPeriod')}`
  return `${hour}:${part('minute')}`
}

export function formatTooltipTime(date: Date, daily: boolean) {
  const part = dateParts(date, { weekday: 'short', month: 'short', day: 'numeric' })
  const day = `${part('weekday')} ${part('month')} ${part('day')}`
  return daily ? day : `${day}, ${formatClock(date)}`
}

export function formatLogTime(iso: string) {
  const part = dateParts(new Date(iso), { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  const ms = String(new Date(iso).getUTCMilliseconds()).padStart(3, '0')
  return `${part('month')} ${part('day')} ${part('hour')}:${part('minute')}:${part('second')}.${ms}`
}

export function timeAgo(iso: string) {
  const seconds = Math.max(0, Math.round((NOW.getTime() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}

// Short relative age without "ago", for dense table cells.
export function shortAge(iso: string) {
  return timeAgo(iso).replace(' ago', '')
}

export function formatMs(ms: number) {
  if (ms < 1) return `${ms.toFixed(2)}ms`
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

export function formatCompact(value: number) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: value < 10_000 ? 1 : 0 }).format(value)
}

export function formatPercent(ratio: number, digits = 1) {
  return `${(ratio * 100).toFixed(digits).replace(/\.0+$/, '')}%`
}

export function formatMoney(value: number) {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
}
