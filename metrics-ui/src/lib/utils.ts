import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const TIMEZONE = 'America/New_York'

export function formatClock(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date)
  const hour = parts.find((part) => part.type === 'hour')?.value ?? ''
  const minute = parts.find((part) => part.type === 'minute')?.value ?? ''
  const dayPeriod = parts.find((part) => part.type === 'dayPeriod')?.value ?? ''
  return `${hour}:${minute} ${dayPeriod}`
}

export function formatTickTime(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0)
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00'
  const dayPeriod = parts.find((part) => part.type === 'dayPeriod')?.value ?? ''
  if (minute === '00') return `${String(hour).padStart(2, '0')} ${dayPeriod}`
  return `${String(hour).padStart(2, '0')}:${minute}`
}

export function formatTooltipTime(date: Date) {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
  }).format(date)
  const month = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    month: 'short',
  }).format(date)
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    day: 'numeric',
  }).format(date)
  return `${weekday} ${month} ${day}, ${formatClock(date)} EDT`
}

export function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds.toFixed(2).replace(/\.?0+$/, '')}s`
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60)
    const rest = Math.round(seconds % 60)
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`
  }
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}

export function formatCompactDuration(seconds: number) {
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 0)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}

export function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 2)} ${units[index]}`
}

export function formatRate(bytesPerSecond: number) {
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatGiB(gib: number) {
  return `${gib.toFixed(2)} GiB`
}

export function formatCores(cores: number) {
  return `${cores.toFixed(cores >= 10 ? 2 : 3).replace(/0+$/, '').replace(/\.$/, '')} cores`
}

export function formatMoney(value: number) {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  })
}

export function formatCount(value: number, digits = 2) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(value) ? 0 : digits,
    maximumFractionDigits: digits,
  })
}
