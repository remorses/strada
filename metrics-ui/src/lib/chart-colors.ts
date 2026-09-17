import { createChartCursor, cursorHost, type ChartCursorState } from '@tanstack/charts/cursor'
import { create } from 'zustand'

export const COLORS = {
  success: 'var(--chart-success)',
  live: 'var(--chart-live)',
  request: 'var(--chart-request)',
  usedCpu: 'var(--chart-used-cpu)',
  usedMemory: 'var(--chart-used-memory)',
  egress: 'var(--chart-egress)',
  ingress: 'var(--chart-ingress)',
  slots: 'var(--chart-slots)',
  pending: 'var(--chart-pending)',
  running: 'var(--chart-running)',
  p50: 'var(--chart-p50)',
  p90: 'var(--chart-p90)',
  usageCpu: 'var(--chart-usage-cpu)',
  usageMemory: 'var(--chart-usage-memory)',
}

export const useChartHover = create<{
  timestampMs: number | null
  setTimestampMs: (timestampMs: number | null) => void
}>((set) => ({
  timestampMs: null,
  setTimestampMs: (timestampMs) => set({ timestampMs }),
}))

export const chartCursor = createChartCursor<Date, number>()
export { cursorHost }

function getCursorTimestamp(state: ChartCursorState<Date, number> | null) {
  if (state?.anchor !== 'value') return null
  const x = state.value.x
  return x instanceof Date ? x.getTime() : null
}

chartCursor.subscribe(() => {
  const timestampMs = getCursorTimestamp(chartCursor.getState())
  if (useChartHover.getState().timestampMs === timestampMs) return
  useChartHover.setState({ timestampMs })
})

useChartHover.subscribe((state, previous) => {
  if (state.timestampMs === previous.timestampMs) return
  if (getCursorTimestamp(chartCursor.getState()) === state.timestampMs) return
  chartCursor.setState(
    state.timestampMs === null
      ? null
      : {
          anchor: 'value',
          value: { x: new Date(state.timestampMs) },
          source: 'programmatic',
          pinned: false,
        },
  )
})
