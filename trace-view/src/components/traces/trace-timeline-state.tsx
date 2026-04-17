/**
 * Timeline state management: types, constants, context provider,
 * reducer, layout logic, gestures, and the main useTraceTimeline hook.
 */
"use client"

import * as React from "react"
import type { ReactNode } from "react"
import type { SpanNode } from "../../lib/utils"

// ─── Types & constants ──────────────────────────────────────────

export interface TimelineBar {
  span: SpanNode
  row: number
  startMs: number
  endMs: number
  depth: number
  parentSpanId: string
  isError: boolean
  isCollapsed: boolean
  childCount: number
}

export interface ViewportState {
  startMs: number
  endMs: number
}

export const ROW_HEIGHT = 24
export const ROW_GAP = 6
export const MINIMAP_HEIGHT = 36
export const TIME_AXIS_HEIGHT = 28
export const DEPTH_INDENT = 16
export const OVERSCAN = 5

// ─── Context ────────────────────────────────────────────────────

interface TraceViewContextValue {
  rootSpans: SpanNode[]
  totalDurationMs: number
  traceStartTime: string
  services: string[]
  selectedSpanId?: string
  onSelectSpan?: (span: SpanNode) => void
}

const TraceViewContext = React.createContext<TraceViewContextValue | null>(null)

export function TraceViewProvider({
  children,
  ...value
}: TraceViewContextValue & { children: ReactNode }) {
  const ctx = React.useMemo(
    () => value,
    [value.rootSpans, value.totalDurationMs, value.traceStartTime, value.services, value.selectedSpanId, value.onSelectSpan],
  )
  return <TraceViewContext value={ctx}>{children}</TraceViewContext>
}

export function useTraceView() {
  const ctx = React.use(TraceViewContext)
  if (!ctx) throw new Error("useTraceView must be used within TraceViewProvider")
  return ctx
}

// ─── Layout ─────────────────────────────────────────────────────

function collectDefaultExpanded(nodes: SpanNode[], depth: number, maxDepth: number): Set<string> {
  const ids = new Set<string>()
  for (const node of nodes) {
    if (node.children.length > 0 && depth < maxDepth) {
      ids.add(node.spanId)
      collectDefaultExpanded(node.children, depth + 1, maxDepth).forEach((id) => ids.add(id))
    }
  }
  return ids
}

function countDescendants(node: SpanNode): number {
  let count = 0
  for (const child of node.children) count += 1 + countDescendants(child)
  return count
}

function layoutSpans(rootSpans: SpanNode[], expandedSpanIds: Set<string>) {
  const bars: TimelineBar[] = []
  let currentRow = 0

  function visit(node: SpanNode) {
    const startMs = new Date(node.startTime).getTime()
    const isCollapsed = node.children.length > 0 && !expandedSpanIds.has(node.spanId)

    bars.push({
      span: node, row: currentRow, startMs, endMs: startMs + node.durationMs,
      depth: node.depth, parentSpanId: node.parentSpanId,
      isError: node.statusCode === "Error", isCollapsed,
      childCount: isCollapsed ? countDescendants(node) : 0,
    })
    currentRow++
    if (!isCollapsed) for (const child of node.children) visit(child)
  }

  for (const root of rootSpans) visit(root)
  return { bars, totalRows: currentRow }
}

// ─── Viewport clamping ──────────────────────────────────────────

export function clampViewport(vp: ViewportState, traceStartMs: number, traceEndMs: number): ViewportState {
  const traceDuration = traceEndMs - traceStartMs
  const clampedDuration = Math.max(traceDuration * 0.001, Math.min(vp.endMs - vp.startMs, traceDuration * 1.1))
  const padding = traceDuration * 0.05
  let startMs = vp.startMs
  let endMs = startMs + clampedDuration
  if (startMs < traceStartMs - padding) { startMs = traceStartMs - padding; endMs = startMs + clampedDuration }
  if (endMs > traceEndMs + padding) { endMs = traceEndMs + padding; startMs = endMs - clampedDuration }
  return { startMs, endMs }
}

// ─── Reducer ────────────────────────────────────────────────────

type TimelineAction =
  | { type: "RESET"; viewport: ViewportState; expandedSpanIds: Set<string> }
  | { type: "SET_VIEWPORT"; viewport: ViewportState }
  | { type: "ZOOM"; centerMs: number; factor: number; traceStartMs: number; traceEndMs: number }
  | { type: "PAN"; deltaMs: number; traceStartMs: number; traceEndMs: number }
  | { type: "ZOOM_TO_SPAN"; startMs: number; endMs: number; traceStartMs: number; traceEndMs: number }
  | { type: "ZOOM_TO_FIT"; traceStartMs: number; traceEndMs: number }
  | { type: "SET_FOCUSED_INDEX"; index: number | null }
  | { type: "FOCUS_NEXT"; maxIndex: number }
  | { type: "FOCUS_PREV" }
  | { type: "SET_SEARCH"; query: string }
  | { type: "TOGGLE_COLLAPSE"; spanId: string }

interface TimelineState {
  viewport: ViewportState
  focusedIndex: number | null
  searchQuery: string
  expandedSpanIds: Set<string>
}

function timelineReducer(state: TimelineState, action: TimelineAction): TimelineState {
  switch (action.type) {
    case "RESET":
      return { viewport: action.viewport, focusedIndex: null, searchQuery: "", expandedSpanIds: action.expandedSpanIds }
    case "SET_VIEWPORT":
      return { ...state, viewport: action.viewport }
    case "ZOOM": {
      const { centerMs, factor, traceStartMs, traceEndMs } = action
      const dur = state.viewport.endMs - state.viewport.startMs
      const newDur = dur / factor
      const ratio = (centerMs - state.viewport.startMs) / dur
      const newStart = centerMs - ratio * newDur
      return { ...state, viewport: clampViewport({ startMs: newStart, endMs: newStart + newDur }, traceStartMs, traceEndMs) }
    }
    case "PAN": {
      const { deltaMs, traceStartMs, traceEndMs } = action
      return { ...state, viewport: clampViewport({ startMs: state.viewport.startMs + deltaMs, endMs: state.viewport.endMs + deltaMs }, traceStartMs, traceEndMs) }
    }
    case "ZOOM_TO_SPAN": {
      const { startMs, endMs, traceStartMs, traceEndMs } = action
      const p = (endMs - startMs) * 0.1
      return { ...state, viewport: clampViewport({ startMs: startMs - p, endMs: endMs + p }, traceStartMs, traceEndMs) }
    }
    case "ZOOM_TO_FIT": {
      const p = (action.traceEndMs - action.traceStartMs) * 0.02
      return { ...state, viewport: { startMs: action.traceStartMs - p, endMs: action.traceEndMs + p } }
    }
    case "SET_FOCUSED_INDEX":
      return { ...state, focusedIndex: action.index }
    case "FOCUS_NEXT":
      return { ...state, focusedIndex: state.focusedIndex === null ? 0 : Math.min(state.focusedIndex + 1, action.maxIndex) }
    case "FOCUS_PREV":
      return { ...state, focusedIndex: state.focusedIndex === null ? 0 : Math.max(0, state.focusedIndex - 1) }
    case "SET_SEARCH":
      return { ...state, searchQuery: action.query }
    case "TOGGLE_COLLAPSE": {
      const next = new Set(state.expandedSpanIds)
      if (next.has(action.spanId)) next.delete(action.spanId); else next.add(action.spanId)
      return { ...state, expandedSpanIds: next }
    }
    default:
      return state
  }
}

// ─── Time axis ticks ────────────────────────────────────────────

const NICE_INTERVALS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5,
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 60000,
]

function computeTimeAxisTicks(viewport: ViewportState, traceStartMs: number): number[] {
  const rawInterval = (viewport.endMs - viewport.startMs) / 6
  let interval = NICE_INTERVALS[NICE_INTERVALS.length - 1]
  for (const nice of NICE_INTERVALS) {
    if (nice >= rawInterval) { interval = nice; break }
  }
  const ticks: number[] = []
  const firstTick = Math.ceil((viewport.startMs - traceStartMs) / interval) * interval
  for (let t = firstTick; t <= viewport.endMs - traceStartMs; t += interval) ticks.push(t)
  return ticks
}

// ─── Search ─────────────────────────────────────────────────────

function computeSearchMatches(bars: TimelineBar[], query: string): Set<string> {
  if (!query.trim()) return new Set()
  const q = query.toLowerCase()
  const matches = new Set<string>()
  for (const bar of bars) {
    if (bar.span.spanName.toLowerCase().includes(q) || bar.span.serviceName.toLowerCase().includes(q)) {
      matches.add(bar.span.spanId)
    }
  }
  return matches
}

// ─── Main hook ──────────────────────────────────────────────────

export function useTraceTimeline({
  rootSpans, totalDurationMs, traceStartTime, defaultExpandDepth = Infinity,
}: {
  rootSpans: SpanNode[]
  totalDurationMs: number
  traceStartTime: string
  defaultExpandDepth?: number
}) {
  const traceStartMs = React.useMemo(() => new Date(traceStartTime).getTime(), [traceStartTime])
  const traceEndMs = traceStartMs + totalDurationMs
  const pad = totalDurationMs * 0.02

  const defaultExpanded = React.useMemo(
    () => collectDefaultExpanded(rootSpans, 0, defaultExpandDepth),
    [rootSpans, defaultExpandDepth]
  )

  const [state, dispatch] = React.useReducer(timelineReducer, {
    viewport: { startMs: traceStartMs - pad, endMs: traceEndMs + pad },
    focusedIndex: null, searchQuery: "", expandedSpanIds: defaultExpanded,
  })

  const rootSpanIdsKey = rootSpans.map((s) => s.spanId).join(",")
  React.useEffect(() => {
    dispatch({ type: "RESET", viewport: { startMs: traceStartMs - pad, endMs: traceEndMs + pad }, expandedSpanIds: defaultExpanded })
  }, [rootSpanIdsKey])

  const { bars, totalRows } = React.useMemo(() => layoutSpans(rootSpans, state.expandedSpanIds), [rootSpans, state.expandedSpanIds])
  const timeAxisTicks = React.useMemo(() => computeTimeAxisTicks(state.viewport, traceStartMs), [state.viewport, traceStartMs])
  const searchMatches = React.useMemo(() => computeSearchMatches(bars, state.searchQuery), [bars, state.searchQuery])

  return {
    bars, totalRows, state, dispatch,
    traceStartMs, traceEndMs, timeAxisTicks, searchMatches,
    isSearchActive: state.searchQuery.trim().length > 0,
  }
}

// ─── Gesture hook (pan/zoom) ────────────────────────────────────

export function useTimelineGestures({
  scrollRef, containerRef, viewport, containerWidth, traceStartMs, traceEndMs, dispatch,
}: {
  scrollRef: React.RefObject<HTMLElement | null>
  containerRef: React.RefObject<HTMLElement | null>
  viewport: ViewportState
  containerWidth: number
  traceStartMs: number
  traceEndMs: number
  dispatch: (action: TimelineAction) => void
}) {
  const isPanning = React.useRef(false)
  const panStart = React.useRef<{ x: number; viewportStartMs: number; viewportEndMs: number } | null>(null)

  const wheelHandlerRef = React.useRef<(e: WheelEvent) => void>(undefined)
  wheelHandlerRef.current = (e: WheelEvent) => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && containerWidth > 0) {
      const deltaMs = (e.deltaX / containerWidth) * (viewport.endMs - viewport.startMs)
      dispatch({ type: "PAN", deltaMs, traceStartMs, traceEndMs })
      e.preventDefault()
      return
    }
    if (e.deltaY !== 0 && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      const el = scrollRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const mousePercent = (e.clientX - rect.left) / rect.width
      const centerMs = viewport.startMs + mousePercent * (viewport.endMs - viewport.startMs)
      dispatch({ type: "ZOOM", centerMs, factor: e.deltaY < 0 ? 1.15 : 1 / 1.15, traceStartMs, traceEndMs })
    }
  }

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const handler = (e: WheelEvent) => wheelHandlerRef.current?.(e)
    el.addEventListener("wheel", handler, { passive: false })
    return () => el.removeEventListener("wheel", handler)
  }, [scrollRef])

  const handleMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("[data-span-id]")) return
      isPanning.current = true
      panStart.current = { x: e.clientX, viewportStartMs: viewport.startMs, viewportEndMs: viewport.endMs }
      e.preventDefault()
    },
    [viewport]
  )

  React.useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isPanning.current || !panStart.current || !containerRef.current) return
      const deltaPercent = (e.clientX - panStart.current.x) / containerRef.current.getBoundingClientRect().width
      const deltaMs = -deltaPercent * (panStart.current.viewportEndMs - panStart.current.viewportStartMs)
      dispatch({
        type: "SET_VIEWPORT",
        viewport: clampViewport(
          { startMs: panStart.current.viewportStartMs + deltaMs, endMs: panStart.current.viewportEndMs + deltaMs },
          traceStartMs, traceEndMs
        ),
      })
    }
    const handleMouseUp = () => { isPanning.current = false; panStart.current = null }
    window.addEventListener("mousemove", handleMouseMove)
    window.addEventListener("mouseup", handleMouseUp)
    return () => { window.removeEventListener("mousemove", handleMouseMove); window.removeEventListener("mouseup", handleMouseUp) }
  }, [containerRef, dispatch, traceStartMs, traceEndMs])

  return { isPanning, handleMouseDown }
}
