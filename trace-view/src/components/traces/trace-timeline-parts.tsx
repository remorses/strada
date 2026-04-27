/**
 * Timeline visual sub-components: span bars, virtualized rows,
 * parent-child connectors, time axis, search bar, and hover tooltip.
 */
"use client"

import * as React from "react"
import {
  cn, formatDuration, getServiceBarColors,
  getServiceLegendColor, calculateSelfTime, getHttpInfo,
} from "../../lib/utils"
import type { SpanNode } from "../../lib/utils"
import type { TimelineBar, ViewportState } from "./trace-timeline-state"
import { ROW_HEIGHT, ROW_GAP, DEPTH_INDENT, TIME_AXIS_HEIGHT, OVERSCAN } from "./trace-timeline-state"

// ─── Span bar ───────────────────────────────────────────────────

export type BarSearchState = "match" | "dimmed" | null

interface TraceTimelineBarProps {
  bar: TimelineBar
  leftPercent: number
  widthPercent: number
  services: string[]
  isSelected: boolean
  isFocused: boolean
  searchState: BarSearchState
  containerWidth: number
  isDark: boolean
}

function TraceTimelineBarInner({
  bar, leftPercent, widthPercent, services, isSelected, isFocused, searchState, containerWidth, isDark,
}: TraceTimelineBarProps) {
  const colors = bar.isError
    ? { bg: isDark ? "oklch(0.40 0.12 25)" : "oklch(0.60 0.13 20)", hover: isDark ? "oklch(0.45 0.14 25)" : "oklch(0.55 0.14 20)" }
    : getServiceBarColors(bar.span.serviceName, services, isDark)

  const barPx = containerWidth > 0 ? (widthPercent / 100) * containerWidth : Infinity
  const showName = barPx > 60
  const showService = barPx > 150
  const showDuration = barPx > 200
  const leftOffset = bar.depth * DEPTH_INDENT

  const barStyle: React.CSSProperties = {
    position: "absolute",
    transform: `translateY(${bar.row * (ROW_HEIGHT + ROW_GAP)}px)`,
    left: `calc(${leftPercent}% + ${leftOffset}px)`,
    width: `calc(${Math.max(widthPercent, 0.3)}% - ${leftOffset}px)`,
    height: ROW_HEIGHT,
    backgroundColor: colors.bg,
    "--hover-bg": colors.hover,
  } as React.CSSProperties

  // Text colors: white on vivid bars in both modes
  const textCls = "text-white"
  const subtextCls = "text-white/70"

  return (
    <div
      data-span-id={bar.span.spanId}
      data-row={bar.row}
      className={cn(
        "trace-timeline-bar flex items-center overflow-hidden rounded-md text-left font-mono text-[11px] font-medium cursor-pointer",
        "transition-[background-color,box-shadow] duration-75",
        isSelected && "ring-2 ring-foreground/30 z-20",
        isFocused && "outline-2 outline-dashed outline-primary outline-offset-[-2px] z-10",
        searchState === "dimmed" && "opacity-25",
        searchState === "match" && "ring-2 ring-foreground/20 z-10",
        bar.span.isMissing && "opacity-60 italic",
      )}
      style={barStyle}
    >
      {bar.span.children.length > 0 && (
        <button
          data-collapse-toggle={bar.span.spanId}
          className={cn("flex items-center justify-center w-4 h-4 shrink-0 ml-1", subtextCls, "hover:text-white")}
          tabIndex={-1}
        >
          {bar.isCollapsed ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 6l6 6-6 6"/></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
          )}
        </button>
      )}
      {bar.span.children.length === 0 && <div className="w-4 shrink-0 ml-1" />}

      {showName ? (
        <div className="flex items-center min-w-0 flex-1 gap-1 px-1">
          <span className={cn("truncate", textCls)}>{bar.span.spanName}</span>
          {showService && (
            <span className={cn("truncate text-[10px] shrink-0", subtextCls)}>{bar.span.serviceName}</span>
          )}
          {bar.isCollapsed && bar.childCount > 0 && (
            <span className={cn("text-[9px] shrink-0", subtextCls)}>+{bar.childCount}</span>
          )}
          {showDuration && (
            <span className={cn("ml-auto shrink-0 pl-1 text-[10px] tabular-nums", subtextCls)}>
              {formatDuration(bar.span.durationMs)}
            </span>
          )}
        </div>
      ) : (
        <div className="flex items-center min-w-0 flex-1 px-1">
          {bar.isCollapsed && bar.childCount > 0 && (
            <span className={cn("text-[9px]", subtextCls)}>+{bar.childCount}</span>
          )}
        </div>
      )}
    </div>
  )
}

const TraceTimelineBar = React.memo(TraceTimelineBarInner, (prev, next) => {
  return (
    prev.bar.span.spanId === next.bar.span.spanId &&
    prev.bar.row === next.bar.row &&
    prev.bar.isCollapsed === next.bar.isCollapsed &&
    prev.leftPercent === next.leftPercent &&
    prev.widthPercent === next.widthPercent &&
    prev.isSelected === next.isSelected &&
    prev.isFocused === next.isFocused &&
    prev.searchState === next.searchState &&
    prev.containerWidth === next.containerWidth &&
    prev.isDark === next.isDark
  )
})

// ─── Virtualized rows ──────────────────────────────────────────

interface TraceTimelineRowsProps {
  bars: TimelineBar[]
  totalRows: number
  viewport: ViewportState
  services: string[]
  selectedSpanId?: string
  focusedIndex: number | null
  searchMatches: Set<string>
  isSearchActive: boolean
  scrollTop: number
  containerHeight: number
  containerWidth: number
  onBarClick: (spanId: string) => void
  onBarDoubleClick: (spanId: string) => void
  onCollapseToggle: (spanId: string) => void
  isDark: boolean
}

export function TraceTimelineRows({
  bars, totalRows, viewport, services, selectedSpanId, focusedIndex,
  searchMatches, isSearchActive, scrollTop, containerHeight, containerWidth,
  onBarClick, onBarDoubleClick, onCollapseToggle, isDark,
}: TraceTimelineRowsProps) {
  const rowSize = ROW_HEIGHT + ROW_GAP
  const totalHeight = totalRows * rowSize
  const visibleDuration = viewport.endMs - viewport.startMs

  const firstVisible = Math.max(0, Math.floor(scrollTop / rowSize) - OVERSCAN)
  const lastVisible = Math.min(totalRows - 1, Math.ceil((scrollTop + containerHeight) / rowSize) + OVERSCAN)

  const visibleBars = React.useMemo(
    () => bars.filter((bar) => bar.row >= firstVisible && bar.row <= lastVisible),
    [bars, firstVisible, lastVisible]
  )

  const handleClick = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      const collapseBtn = target.closest("[data-collapse-toggle]") as HTMLElement | null
      if (collapseBtn) {
        const spanId = collapseBtn.getAttribute("data-collapse-toggle")
        if (spanId) { e.stopPropagation(); onCollapseToggle(spanId); return }
      }
      const barEl = target.closest("[data-span-id]") as HTMLElement | null
      if (barEl) {
        const spanId = barEl.getAttribute("data-span-id")
        if (spanId) onBarClick(spanId)
      }
    },
    [onBarClick, onCollapseToggle]
  )

  const handleDoubleClick = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      const barEl = target.closest("[data-span-id]") as HTMLElement | null
      if (barEl) {
        const spanId = barEl.getAttribute("data-span-id")
        if (spanId) onBarDoubleClick(spanId)
      }
    },
    [onBarDoubleClick]
  )

  return (
    <div className="relative" style={{ height: totalHeight }} onClick={handleClick} onDoubleClick={handleDoubleClick}>
      {visibleBars.map((bar) => {
        const leftPercent = ((bar.startMs - viewport.startMs) / visibleDuration) * 100
        const widthPercent = ((bar.endMs - bar.startMs) / visibleDuration) * 100
        const searchState: BarSearchState = isSearchActive
          ? searchMatches.has(bar.span.spanId) ? "match" : "dimmed"
          : null
        return (
          <TraceTimelineBar
            key={bar.span.spanId}
            bar={bar}
            leftPercent={leftPercent}
            widthPercent={widthPercent}
            services={services}
            isSelected={selectedSpanId === bar.span.spanId}
            isFocused={focusedIndex !== null && bar.row === focusedIndex}
            searchState={searchState}
            containerWidth={containerWidth}
            isDark={isDark}
          />
        )
      })}
    </div>
  )
}

// ─── Parent-child connectors (SVG) ─────────────────────────────

interface TraceTimelineConnectorsProps {
  bars: TimelineBar[]
  totalRows: number
  scrollTop: number
  containerHeight: number
}

export function TraceTimelineConnectors({ bars, totalRows, scrollTop, containerHeight }: TraceTimelineConnectorsProps) {
  const rowSize = ROW_HEIGHT + ROW_GAP
  const totalHeight = totalRows * rowSize

  const parentRowMap = React.useMemo(() => {
    const map = new Map<string, number>()
    for (const bar of bars) map.set(bar.span.spanId, bar.row)
    return map
  }, [bars])

  const firstVisible = Math.max(0, Math.floor(scrollTop / rowSize) - 2)
  const lastVisible = Math.min(totalRows - 1, Math.ceil((scrollTop + containerHeight) / rowSize) + 2)

  const lines: React.ReactNode[] = []

  for (const bar of bars) {
    if (bar.row < firstVisible || bar.row > lastVisible) continue
    if (!bar.parentSpanId) continue
    const parentRow = parentRowMap.get(bar.parentSpanId)
    if (parentRow === undefined) continue

    const parentY = parentRow * rowSize + ROW_HEIGHT
    const childY = bar.row * rowSize + ROW_HEIGHT / 2
    const xIndent = bar.depth * DEPTH_INDENT
    const verticalX = xIndent - DEPTH_INDENT / 2

    lines.push(
      <React.Fragment key={`conn-${bar.span.spanId}`}>
        <line x1={verticalX} y1={parentY} x2={verticalX} y2={childY} className="stroke-foreground/[0.08]" strokeWidth={1} />
        <line x1={verticalX} y1={childY} x2={xIndent - 2} y2={childY} className="stroke-foreground/[0.08]" strokeWidth={1} />
      </React.Fragment>
    )
  }

  return (
    <svg className="absolute inset-0 pointer-events-none z-0" style={{ height: totalHeight, width: "100%" }} preserveAspectRatio="none">
      {lines}
    </svg>
  )
}

// ─── Time axis ──────────────────────────────────────────────────

interface TraceTimelineTimeAxisProps {
  viewport: ViewportState
  ticks: number[]
  traceStartMs: number
}

export function TraceTimelineTimeAxis({ viewport, ticks, traceStartMs }: TraceTimelineTimeAxisProps) {
  const visibleDuration = viewport.endMs - viewport.startMs

  return (
    <div className="sticky top-0 z-20 flex items-end border-b border-border bg-background/95 backdrop-blur-sm px-0" style={{ height: TIME_AXIS_HEIGHT }}>
      {ticks.map((offsetMs) => {
        const absMs = traceStartMs + offsetMs
        const leftPercent = ((absMs - viewport.startMs) / visibleDuration) * 100
        if (leftPercent < -5 || leftPercent > 105) return null
        return (
          <div key={offsetMs} className="absolute flex flex-col items-center pointer-events-none" style={{ left: `${leftPercent}%`, bottom: 4 }}>
            <span className="text-[10px] font-mono font-medium text-muted-foreground whitespace-nowrap -translate-x-1/2">
              {formatDuration(offsetMs)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ─── Search bar ─────────────────────────────────────────────────

interface TraceTimelineSearchProps {
  query: string
  onQueryChange: (query: string) => void
  matchCount: number
  totalCount: number
  inputRef: React.RefObject<HTMLInputElement | null>
}

export function TraceTimelineSearch({ query, onQueryChange, matchCount, totalCount, inputRef }: TraceTimelineSearchProps) {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-3 py-1.5">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground shrink-0">
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
      </svg>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search spans..."
        className="flex-1 bg-transparent text-xs font-mono text-foreground placeholder:text-muted-foreground/50 outline-none"
      />
      {query && (
        <>
          <span className="text-[10px] font-mono text-muted-foreground shrink-0 tabular-nums">
            {matchCount} of {totalCount}
          </span>
          <button onClick={() => onQueryChange("")} className="text-muted-foreground hover:text-foreground shrink-0">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </>
      )}
    </div>
  )
}

// ─── Hover tooltip ──────────────────────────────────────────────

const kindLabels: Record<string, string> = {
  SPAN_KIND_SERVER: "Server",
  SPAN_KIND_CLIENT: "Client",
  SPAN_KIND_PRODUCER: "Producer",
  SPAN_KIND_CONSUMER: "Consumer",
  SPAN_KIND_INTERNAL: "Internal",
}

interface TraceTimelineTooltipProps {
  span: SpanNode
  services?: string[]
  totalDurationMs?: number
  traceStartTime?: string
}

export function TraceTimelineTooltipContent({ span, services, totalDurationMs, traceStartTime }: TraceTimelineTooltipProps) {
  const kindLabel = kindLabels[span.spanKind] ?? span.spanKind?.replace("SPAN_KIND_", "") ?? "Unknown"
  const serviceColor = services ? getServiceLegendColor(span.serviceName, services) : null
  const selfTime = calculateSelfTime(span, span.children)
  const selfTimePercent = span.durationMs > 0 ? (selfTime / span.durationMs) * 100 : 0
  const durationPercent = totalDurationMs ? (span.durationMs / totalDurationMs) * 100 : null
  const startOffset = traceStartTime ? new Date(span.startTime).getTime() - new Date(traceStartTime).getTime() : null
  const httpInfo = getHttpInfo(span.spanName, span.spanAttributes)

  return (
    <div className="flex flex-col gap-2 font-mono text-xs">
      <div className="flex items-center gap-2">
        {serviceColor && <div className="h-2.5 w-2.5 shrink-0" style={{ backgroundColor: serviceColor }} />}
        <span className="font-medium truncate">{span.spanName}</span>
      </div>
      {durationPercent !== null && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">Duration</span>
            <span>{formatDuration(span.durationMs)} ({durationPercent.toFixed(1)}%)</span>
          </div>
          <div className="h-1.5 w-full bg-muted overflow-hidden">
            <div className="h-full bg-primary/70" style={{ width: `${Math.max(durationPercent, 1)}%` }} />
          </div>
        </div>
      )}
      {span.children.length > 0 && (
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-muted-foreground">Self time</span>
          <span>{formatDuration(selfTime)} ({selfTimePercent.toFixed(0)}%)</span>
        </div>
      )}
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px]">
        <span className="text-muted-foreground">Service</span><span>{span.serviceName}</span>
        <span className="text-muted-foreground">Kind</span><span>{kindLabel}</span>
        {startOffset !== null && (<><span className="text-muted-foreground">Start offset</span><span>+{formatDuration(startOffset)}</span></>)}
        {durationPercent === null && (<><span className="text-muted-foreground">Duration</span><span>{formatDuration(span.durationMs)}</span></>)}
        <span className="text-muted-foreground">Status</span>
        <span className={span.statusCode === "Error" ? "text-destructive" : span.statusCode === "Ok" ? "text-info" : ""}>
          {span.statusCode || "Unset"}
        </span>
      </div>
      {httpInfo && (
        <div className="border-t border-border pt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px]">
          <span className="text-muted-foreground">Method</span><span className="font-medium">{httpInfo.method}</span>
          {httpInfo.statusCode != null && (<><span className="text-muted-foreground">HTTP</span><span className={httpInfo.statusCode >= 400 ? "text-destructive" : httpInfo.statusCode >= 300 ? "text-warning" : "text-info"}>{httpInfo.statusCode}</span></>)}
          {httpInfo.route && (<><span className="text-muted-foreground">Route</span><span className="truncate max-w-[180px]">{httpInfo.route}</span></>)}
        </div>
      )}
      {span.statusMessage && (
        <div className="border-t border-border pt-1.5 text-[10px]">
          <span className="text-muted-foreground">Message: </span>{span.statusMessage}
        </div>
      )}
    </div>
  )
}
