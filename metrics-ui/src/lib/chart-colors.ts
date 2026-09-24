import { createChartCursor, cursorHost, type ChartCursorState } from '@tanstack/charts/cursor'
import { create } from 'zustand'

export const COLORS = {
  primary: 'var(--chart-primary)',
  secondary: 'var(--chart-secondary)',
  success: 'var(--chart-success)',
  warning: 'var(--chart-warning)',
  error: 'var(--chart-error)',
  muted: 'var(--chart-muted)',
  p50: 'var(--chart-p50)',
  p95: 'var(--chart-p95)',
  p99: 'var(--chart-p99)',
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
