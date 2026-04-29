/**
 * Shared utilities: types, formatting, colors, HTTP span parsing,
 * class merging, and hooks used across the trace timeline.
 */

import * as React from "react"
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

// ─── Class merge ────────────────────────────────────────────────

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ─── Span types ─────────────────────────────────────────────────

export interface SpanNode {
  traceId: string
  spanId: string
  parentSpanId: string
  spanName: string
  serviceName: string
  spanKind: string
  durationMs: number
  startTime: string
  statusCode: string
  statusMessage: string
  spanAttributes: Record<string, string>
  resourceAttributes: Record<string, string>
  children: SpanNode[]
  depth: number
  isMissing?: boolean
}

// ─── Formatting ─────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

// ─── Service colors (OKLCH, vivid palette) ─────────────────────
// Hand-picked hues for maximum visual distinction. Warm-biased
// palette inspired by modern observability UIs: oranges, teals,
// purples, greens. Each service gets a saturated, vibrant color.

const SERVICE_PALETTE = [
  { hue: 250, c: 0.11 }, // Indigo
  { hue: 165, c: 0.10 }, // Teal
  { hue: 45,  c: 0.11 }, // Amber
  { hue: 330, c: 0.10 }, // Rose
  { hue: 140, c: 0.10 }, // Emerald
  { hue: 290, c: 0.09 }, // Purple
  { hue: 200, c: 0.10 }, // Cyan
  { hue: 20,  c: 0.11 }, // Coral
  { hue: 85,  c: 0.10 }, // Lime
  { hue: 270, c: 0.09 }, // Violet
  { hue: 180, c: 0.09 }, // Aqua
  { hue: 355, c: 0.11 }, // Red
]

function getServiceColor(idx: number) {
  if (idx < SERVICE_PALETTE.length) return SERVICE_PALETTE[idx]
  const hue = (idx * 137.508) % 360
  return { hue, c: 0.10 }
}

export function getServiceLegendColor(serviceName: string, services: string[]): string {
  const { hue, c } = getServiceColor(services.indexOf(serviceName))
  return `oklch(0.58 ${c} ${hue})`
}

/** Returns { bg, hover } colors for a span bar. */
export function getServiceBarColors(serviceName: string, services: string[], isDark: boolean) {
  const { hue, c } = getServiceColor(services.indexOf(serviceName))
  if (isDark) {
    return {
      bg: `oklch(0.45 ${c} ${hue})`,
      hover: `oklch(0.50 ${c + 0.02} ${hue})`,
    }
  }
  return {
    bg: `oklch(0.65 ${c} ${hue})`,
    hover: `oklch(0.60 ${c + 0.01} ${hue})`,
  }
}

export function calculateSelfTime(
  span: { startTime: string; durationMs: number },
  children: Array<{ startTime: string; durationMs: number }>
): number {
  if (children.length === 0) return span.durationMs

  const spanStartMs = new Date(span.startTime).getTime()
  const spanEndMs = spanStartMs + span.durationMs

  const intervals = children
    .map((c) => ({
      start: Math.max(new Date(c.startTime).getTime(), spanStartMs),
      end: Math.min(new Date(c.startTime).getTime() + c.durationMs, spanEndMs),
    }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start)

  if (intervals.length === 0) return span.durationMs

  // Merge overlapping intervals
  const merged = [intervals[0]]
  for (let i = 1; i < intervals.length; i++) {
    const last = merged[merged.length - 1]
    if (intervals[i].start <= last.end) {
      last.end = Math.max(last.end, intervals[i].end)
    } else {
      merged.push(intervals[i])
    }
  }

  const childrenTime = merged.reduce((sum, i) => sum + (i.end - i.start), 0)
  return Math.max(0, span.durationMs - childrenTime)
}

// ─── HTTP span parsing ──────────────────────────────────────────

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const

export function getHttpInfo(spanName: string, attrs: Record<string, string>) {
  let method = attrs["http.method"] || attrs["http.request.method"]
  let route: string | null = attrs["http.route"] || attrs["http.target"] || attrs["url.path"] || null

  if (!method) {
    const parts = spanName.split(" ")
    if (parts.length >= 2 && HTTP_METHODS.includes(parts[0].toUpperCase() as (typeof HTTP_METHODS)[number])) {
      method = parts[0].toUpperCase()
      if (!route) route = parts.slice(1).join(" ")
    }
  }

  if (!method) return null

  const rawStatus = attrs["http.status_code"] || attrs["http.response.status_code"]
  const statusCode = rawStatus ? parseInt(rawStatus, 10) || null : null

  return { method: method.toUpperCase(), route, statusCode }
}

// ─── OTel DB row type (PascalCase, matches Tinybird/ClickHouse query results) ──

export interface OtelTraceRow {
  TraceId: string
  SpanId: string
  ParentSpanId: string
  SpanName: string
  ServiceName: string
  SpanKind: string
  /** Nanoseconds */
  Duration: number
  /** DateTime64(9) — ISO 8601 string from ClickHouse JSON response */
  Timestamp: string
  StatusCode: string
  StatusMessage: string
  SpanAttributes: Record<string, string>
  ResourceAttributes: Record<string, string>
}

// ─── Build span tree from flat DB rows ──────────────────────────

export function buildSpanTree(rows: OtelTraceRow[]) {
  const byId = new Map<string, SpanNode>()

  for (const row of rows) {
    byId.set(row.SpanId, {
      traceId: row.TraceId,
      spanId: row.SpanId,
      parentSpanId: row.ParentSpanId,
      spanName: row.SpanName,
      serviceName: row.ServiceName,
      spanKind: row.SpanKind,
      durationMs: row.Duration / 1_000_000,
      startTime: row.Timestamp,
      statusCode: row.StatusCode,
      statusMessage: row.StatusMessage,
      spanAttributes: row.SpanAttributes,
      resourceAttributes: row.ResourceAttributes,
      children: [],
      depth: 0,
    })
  }

  // Link children → parents
  const roots: SpanNode[] = []
  for (const node of byId.values()) {
    const parent = node.parentSpanId ? byId.get(node.parentSpanId) : undefined
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  // Set depth + sort children by start time
  function setDepth(node: SpanNode, depth: number) {
    node.depth = depth
    node.children.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    for (const child of node.children) setDepth(child, depth + 1)
  }
  for (const root of roots) setDepth(root, 0)
  roots.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())

  // Derive metadata
  let traceStartMs = Infinity
  let traceEndMs = -Infinity
  const serviceSet = new Set<string>()
  for (const row of rows) {
    const startMs = new Date(row.Timestamp).getTime()
    const endMs = startMs + row.Duration / 1_000_000
    if (startMs < traceStartMs) traceStartMs = startMs
    if (endMs > traceEndMs) traceEndMs = endMs
    serviceSet.add(row.ServiceName)
  }

  return {
    rootSpans: roots,
    totalDurationMs: traceEndMs - traceStartMs,
    traceStartTime: new Date(traceStartMs).toISOString(),
    services: [...serviceSet],
  }
}

// ─── Dark mode detection (hydration-safe) ───────────────────────

function getIsDark(): boolean {
  return document.documentElement.classList.contains("dark")
}
const getServerIsDark = () => false

function subscribeTheme(cb: () => void) {
  const observer = new MutationObserver(cb)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => observer.disconnect()
}

export function useIsDark() {
  return React.useSyncExternalStore(subscribeTheme, getIsDark, getServerIsDark)
}

// ─── Hooks ──────────────────────────────────────────────────────

export function useContainerSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = React.useState({ width: 0, height: 0 })

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])

  return size
}
