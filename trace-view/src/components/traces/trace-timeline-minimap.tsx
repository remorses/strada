"use client"

import * as React from "react"
import { getServiceLegendColor, type SpanNode } from "../../lib/utils"
import type { ViewportState } from "./trace-timeline-state"
import { MINIMAP_HEIGHT } from "./trace-timeline-state"

interface TraceTimelineMinimapProps {
  rootSpans: SpanNode[]
  totalDurationMs: number
  traceStartMs: number
  traceEndMs: number
  services: string[]
  viewport: ViewportState
  onViewportChange: (viewport: ViewportState) => void
}

interface MinimapSpan { spanId: string; depth: number; leftPercent: number; widthPercent: number; bgColor: string }

function collectMinimapSpans(rootSpans: SpanNode[], traceStartMs: number, totalDurationMs: number, services: string[]) {
  const spans: MinimapSpan[] = []
  let maxDepth = 0
  function visit(node: SpanNode) {
    const startMs = new Date(node.startTime).getTime()
    const leftPercent = ((startMs - traceStartMs) / totalDurationMs) * 100
    const widthPercent = (node.durationMs / totalDurationMs) * 100
    maxDepth = Math.max(maxDepth, node.depth)
    spans.push({
      spanId: node.spanId, depth: node.depth,
      leftPercent: Math.max(0, leftPercent),
      widthPercent: Math.min(widthPercent, 100 - Math.max(0, leftPercent)),
      bgColor: node.statusCode === "Error"
        ? "oklch(0.55 0.22 20)"
        : getServiceLegendColor(node.serviceName, services),
    })
    node.children.forEach(visit)
  }
  rootSpans.forEach(visit)
  return { spans, maxDepth }
}

export function TraceTimelineMinimap({
  rootSpans, totalDurationMs, traceStartMs, traceEndMs, services, viewport, onViewportChange,
}: TraceTimelineMinimapProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const dragRef = React.useRef<{ type: "pan" | "resize-left" | "resize-right"; startX: number; startViewport: ViewportState } | null>(null)

  const { spans } = React.useMemo(
    () => collectMinimapSpans(rootSpans, traceStartMs, totalDurationMs, services),
    [rootSpans, traceStartMs, totalDurationMs, services]
  )

  const ROW_H = 3
  const traceDuration = traceEndMs - traceStartMs
  const rawVpLeft = ((viewport.startMs - traceStartMs) / traceDuration) * 100
  const rawVpWidth = ((viewport.endMs - viewport.startMs) / traceDuration) * 100
  // Clamp the indicator so it never overflows the minimap bounds
  const vpLeftPercent = Math.max(0, rawVpLeft)
  const vpWidthPercent = Math.min(100 - vpLeftPercent, rawVpWidth)

  function clampToTrace(vp: ViewportState): ViewportState {
    const dur = vp.endMs - vp.startMs
    let s = vp.startMs
    let e = vp.endMs
    if (s < traceStartMs) { s = traceStartMs; e = s + dur }
    if (e > traceEndMs) { e = traceEndMs; s = e - dur }
    return { startMs: Math.max(s, traceStartMs), endMs: Math.min(e, traceEndMs) }
  }

  const handleMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      if (!containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const clickPercent = ((e.clientX - rect.left) / rect.width) * 100
      const edgeThreshold = 2
      if (clickPercent >= vpLeftPercent - edgeThreshold && clickPercent <= vpLeftPercent + edgeThreshold) {
        dragRef.current = { type: "resize-left", startX: e.clientX, startViewport: { ...viewport } }
      } else if (clickPercent >= vpLeftPercent + vpWidthPercent - edgeThreshold && clickPercent <= vpLeftPercent + vpWidthPercent + edgeThreshold) {
        dragRef.current = { type: "resize-right", startX: e.clientX, startViewport: { ...viewport } }
      } else if (clickPercent >= vpLeftPercent && clickPercent <= vpLeftPercent + vpWidthPercent) {
        dragRef.current = { type: "pan", startX: e.clientX, startViewport: { ...viewport } }
      } else {
        const clickMs = traceStartMs + (clickPercent / 100) * traceDuration
        const vpDuration = viewport.endMs - viewport.startMs
        onViewportChange(clampToTrace({ startMs: clickMs - vpDuration / 2, endMs: clickMs + vpDuration / 2 }))
      }
      e.preventDefault()
    },
    [viewport, vpLeftPercent, vpWidthPercent, traceStartMs, traceDuration, onViewportChange]
  )

  React.useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const deltaPercent = ((e.clientX - dragRef.current.startX) / rect.width) * 100
      const deltaMs = (deltaPercent / 100) * traceDuration
      const sv = dragRef.current.startViewport
      switch (dragRef.current.type) {
        case "pan": onViewportChange(clampToTrace({ startMs: sv.startMs + deltaMs, endMs: sv.endMs + deltaMs })); break
        case "resize-left": onViewportChange(clampToTrace({ startMs: Math.min(sv.startMs + deltaMs, sv.endMs - traceDuration * 0.01), endMs: sv.endMs })); break
        case "resize-right": onViewportChange(clampToTrace({ startMs: sv.startMs, endMs: Math.max(sv.endMs + deltaMs, sv.startMs + traceDuration * 0.01) })); break
      }
    }
    const handleMouseUp = () => { dragRef.current = null }
    window.addEventListener("mousemove", handleMouseMove)
    window.addEventListener("mouseup", handleMouseUp)
    return () => { window.removeEventListener("mousemove", handleMouseMove); window.removeEventListener("mouseup", handleMouseUp) }
  }, [traceDuration, onViewportChange])

  return (
    <div ref={containerRef} className="relative border-b border-border bg-muted/10 cursor-crosshair select-none" style={{ height: MINIMAP_HEIGHT }} onMouseDown={handleMouseDown}>
      <div className="absolute inset-x-0 inset-y-0 px-0" style={{ paddingTop: 2, paddingBottom: 2 }}>
        {spans.map((s) => (
          <div key={s.spanId} className="absolute" style={{ top: Math.min(s.depth * (ROW_H + 1) + 2, MINIMAP_HEIGHT - ROW_H - 2), left: `${s.leftPercent}%`, width: `${Math.max(s.widthPercent, 0.2)}%`, height: ROW_H, backgroundColor: s.bgColor }} />
        ))}
      </div>
      <div className="absolute inset-y-0 bg-background/60" style={{ left: 0, width: `${Math.max(0, vpLeftPercent)}%` }} />
      <div className="absolute inset-y-0 bg-background/60" style={{ left: `${vpLeftPercent + vpWidthPercent}%`, right: 0 }} />
      <div className="absolute inset-y-0 border-x-2 border-primary/60 cursor-grab active:cursor-grabbing" style={{ left: `${vpLeftPercent}%`, width: `${Math.max(vpWidthPercent, 1)}%` }} />
    </div>
  )
}
