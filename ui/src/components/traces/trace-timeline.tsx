/**
 * Main trace timeline component — orchestrates the minimap, time axis,
 * virtualized rows, connectors, search, tooltip, and service legend.
 */
"use client"

import * as React from "react"
import * as ReactDOM from "react-dom"

import { getServiceLegendColor, useContainerSize, useIsDark } from "../../lib/utils.ts"
import type { SpanNode } from "../../lib/utils.ts"
import { TraceViewContext, useTraceTimeline, useTimelineGestures, ROW_HEIGHT, ROW_GAP } from "./trace-timeline-state.tsx"
import type { TraceViewContextValue } from "./trace-timeline-state.tsx"
import { TraceTimelineSearch, TraceTimelineTimeAxis, TraceTimelineRows, TraceTimelineConnectors, TraceTimelineTooltipContent } from "./trace-timeline-parts.tsx"
import { TraceTimelineMinimap } from "./trace-timeline-minimap.tsx"

export type TraceTimelineProps = TraceViewContextValue

export function TraceTimeline(props?: TraceTimelineProps) {
  const context = React.use(TraceViewContext)
  const value = props ?? context
  if (!value) throw new Error("TraceTimeline needs props or a TraceViewProvider")
  const { rootSpans, totalDurationMs, traceStartTime, services, selectedSpanId, onSelectSpan } = value
  const isDark = useIsDark()
  const containerRef = React.useRef<HTMLDivElement>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const tooltipRef = React.useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = React.useState(0)
  const [hoveredSpan, setHoveredSpan] = React.useState<SpanNode | null>(null)
  const [tooltipPos, setTooltipPos] = React.useState<{ x: number; y: number } | null>(null)

  const containerSize = useContainerSize(scrollRef)

  const { bars, totalRows, state, dispatch, traceStartMs, traceEndMs, timeAxisTicks, searchMatches, isSearchActive } = useTraceTimeline({
    rootSpans, totalDurationMs, traceStartTime, defaultExpandDepth: Infinity,
  })

  const { isPanning, handleMouseDown } = useTimelineGestures({
    scrollRef, containerRef, viewport: state.viewport, containerWidth: containerSize.width,
    traceStartMs, traceEndMs, dispatch,
  })

  const handleScroll = React.useCallback(() => {
    if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop)
  }, [])

  const handleMouseMoveForTooltip = React.useCallback(
    (e: React.MouseEvent) => {
      if (!(e.target instanceof HTMLElement)) return
      const barEl = e.target.closest("[data-span-id]")
      if (barEl) {
        const spanId = barEl.getAttribute("data-span-id")
        const span = bars.find((b) => b.span.spanId === spanId)?.span ?? null
        setHoveredSpan(span)
        if (span) setTooltipPos({ x: e.clientX, y: e.clientY })
      } else {
        setHoveredSpan(null)
        setTooltipPos(null)
      }
    },
    [bars]
  )

  const handleMouseLeaveContainer = React.useCallback(() => {
    setHoveredSpan(null)
    setTooltipPos(null)
  }, [])

  const handleBarClick = React.useCallback(
    (spanId: string) => {
      const bar = bars.find((b) => b.span.spanId === spanId)
      if (bar && onSelectSpan) onSelectSpan(bar.span)
    },
    [bars, onSelectSpan]
  )

  const handleBarDoubleClick = React.useCallback(
    (spanId: string) => {
      const bar = bars.find((b) => b.span.spanId === spanId)
      if (bar) dispatch({ type: "ZOOM_TO_SPAN", startMs: bar.startMs, endMs: bar.endMs, traceStartMs, traceEndMs })
    },
    [bars, dispatch, traceStartMs, traceEndMs]
  )

  const handleCollapseToggle = React.useCallback(
    (spanId: string) => dispatch({ type: "TOGGLE_COLLAPSE", spanId }),
    [dispatch]
  )

  const handleMinimapViewportChange = React.useCallback(
    (viewport: { startMs: number; endMs: number }) => dispatch({ type: "SET_VIEWPORT", viewport }),
    [dispatch]
  )

  const handleZoomToFit = React.useCallback(() => {
    dispatch({ type: "ZOOM_TO_FIT", traceStartMs, traceEndMs })
  }, [dispatch, traceStartMs, traceEndMs])

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown": e.preventDefault(); dispatch({ type: "FOCUS_NEXT", maxIndex: bars.length - 1 }); break
        case "ArrowUp": e.preventDefault(); dispatch({ type: "FOCUS_PREV" }); break
        case "/": e.preventDefault(); searchInputRef.current?.focus(); break
        case "Escape":
          if (state.searchQuery) dispatch({ type: "SET_SEARCH", query: "" })
          else if (state.focusedIndex !== null) dispatch({ type: "SET_FOCUSED_INDEX", index: null })
          break
      }
    },
    [state.focusedIndex, state.searchQuery, bars, dispatch]
  )

  const visibleDuration = state.viewport.endMs - state.viewport.startMs
  const rowSize = ROW_HEIGHT + ROW_GAP
  const fullDuration = traceEndMs - traceStartMs
  const isZoomed = visibleDuration < fullDuration * 0.95

  if (rootSpans.length === 0) {
    return <div className="border p-8 text-center"><p className="text-muted-foreground">No spans found for this trace</p></div>
  }

  return (
    <div ref={containerRef} className="border flex flex-col h-full outline-none relative" tabIndex={0}
      onKeyDown={handleKeyDown} onMouseMove={handleMouseMoveForTooltip} onMouseLeave={handleMouseLeaveContainer}>
      <TraceTimelineSearch query={state.searchQuery} onQueryChange={(q) => dispatch({ type: "SET_SEARCH", query: q })}
        matchCount={searchMatches.size} totalCount={bars.length} inputRef={searchInputRef} />

      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-1.5 shrink-0">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-medium">Timeline</span>
          <span className="tabular-nums">{bars.length} spans</span>
        </div>
        {isZoomed && (
          <button onClick={handleZoomToFit} className="h-5 gap-1 text-[10px] px-2 text-muted-foreground hover:text-foreground flex items-center">
            Fit
          </button>
        )}
      </div>

      <TraceTimelineMinimap rootSpans={rootSpans} totalDurationMs={totalDurationMs}
        traceStartMs={traceStartMs} traceEndMs={traceEndMs} services={services}
        viewport={state.viewport} onViewportChange={handleMinimapViewportChange} />

      <TraceTimelineTimeAxis viewport={state.viewport} ticks={timeAxisTicks} traceStartMs={traceStartMs} />

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto relative scrollbar-none"
        style={{ cursor: isPanning.current ? "grabbing" : undefined }}
        onScroll={handleScroll} onMouseDown={handleMouseDown}>
        <div className="absolute inset-0 pointer-events-none z-0" style={{ height: totalRows * rowSize }}>
          {timeAxisTicks.map((offsetMs) => {
            const absMs = traceStartMs + offsetMs
            const leftPercent = ((absMs - state.viewport.startMs) / visibleDuration) * 100
            if (leftPercent < -1 || leftPercent > 101) return null
            return <div key={`grid-${offsetMs}`} className="absolute top-0 bottom-0 border-l border-dashed border-foreground/[0.04]" style={{ left: `${leftPercent}%` }} />
          })}
        </div>
        <TraceTimelineConnectors bars={bars} totalRows={totalRows} scrollTop={scrollTop} containerHeight={containerSize.height} />
        <TraceTimelineRows bars={bars} totalRows={totalRows} viewport={state.viewport} services={services}
          selectedSpanId={selectedSpanId} focusedIndex={state.focusedIndex}
          searchMatches={searchMatches} isSearchActive={isSearchActive}
          scrollTop={scrollTop} containerHeight={containerSize.height} containerWidth={containerSize.width}
          onBarClick={handleBarClick} onBarDoubleClick={handleBarDoubleClick} onCollapseToggle={handleCollapseToggle} isDark={isDark} />
      </div>

      <div className="flex items-center justify-between border-t border-border bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground shrink-0">
        <div className="flex items-center gap-3 text-foreground/30">
          <span><kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[9px]">Click</kbd> select</span>
          <span><kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[9px]">Dbl-click</kbd> zoom</span>
          <span><kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[9px]">Ctrl+Scroll</kbd> zoom</span>
          <span><kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[9px]">/</kbd> search</span>
        </div>
        <div className="flex items-center gap-2.5">
          {services.map((service) => (
            <div key={service} className="flex items-center gap-1">
              <div className="h-2 w-2 shrink-0" style={{ backgroundColor: getServiceLegendColor(service, services) }} />
              <span className="font-medium">{service}</span>
            </div>
          ))}
          <div className="flex items-center gap-1">
            <div className="h-2 w-2 bg-destructive shrink-0" />
            <span className="font-medium">Error</span>
          </div>
        </div>
      </div>

      {hoveredSpan && tooltipPos && ReactDOM.createPortal(
        <div ref={tooltipRef} className="fixed z-[9999] pointer-events-none"
          style={{ left: tooltipPos.x, top: tooltipPos.y - 8, transform: "translate(-50%, -100%)" }}>
          <div className="bg-popover text-popover-foreground border border-border shadow-lg p-2.5 max-w-sm">
            <TraceTimelineTooltipContent span={hoveredSpan} services={services} totalDurationMs={totalDurationMs} traceStartTime={traceStartTime} />
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
