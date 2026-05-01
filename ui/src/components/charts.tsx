/**
 * Reusable ECharts-based chart components copied from Cloudflare Kumo's
 * MIT-licensed chart package and adapted to Strada's shadcn/Tailwind tokens.
 * Portions Copyright (c) 2026 Cloudflare, Inc. SPDX-License-Identifier: MIT.
 * Original sources:
 * - https://github.com/cloudflare/kumo/blob/main/packages/kumo/src/components/chart/EChart.tsx
 * - https://github.com/cloudflare/kumo/blob/main/packages/kumo/src/components/chart/TimeseriesChart.tsx
 * - https://github.com/cloudflare/kumo/blob/main/packages/kumo/src/components/chart/Legend.tsx
 */
'use client'

import type { SetOptionOpts } from 'echarts'
import type * as echarts from 'echarts/core'
import type { Ref } from 'react'
import { useEffect, useMemo, useRef } from 'react'

import { getDefaultChartColors, resolveChartColor, type ChartColor } from '../lib/chart-palette.ts'
import {
  buildTimeseriesChartOption,
  prepareChartOptions,
  type BuildTimeseriesChartOptionOptions,
  type StradaChartOption,
} from '../lib/echarts-options.ts'
import { cn, useIsDark } from '../lib/utils.ts'

type EChartsMouseEventParams = {
  componentType: string
  seriesType?: string
  seriesIndex?: number
  seriesName?: string
  name?: string
  dataIndex?: number
  data?: any
  dataType?: string
  value?: number | any[]
  color?: string
}

export interface ChartEvents {
  [event: string]: ((params: any) => void) | undefined
  click: (params: EChartsMouseEventParams) => void
  dblclick: (params: EChartsMouseEventParams) => void
  mousedown: (params: EChartsMouseEventParams) => void
  mousemove: (params: EChartsMouseEventParams) => void
  mouseup: (params: EChartsMouseEventParams) => void
  mouseover: (params: EChartsMouseEventParams) => void
  mouseout: (params: EChartsMouseEventParams) => void
  globalout: (params: any) => void
  contextmenu: (params: any) => void
  legendselectchanged: (params: { name: string; selected: Record<string, boolean> }) => void
  legendselected: (params: any) => void
  legendunselected: (params: any) => void
  legendscroll: (params: any) => void
  datazoom: (params: any) => void
  datarangeselected: (params: any) => void
  timelinechanged: (params: any) => void
  timelineplaychanged: (params: any) => void
  restore: (params: any) => void
  dataviewchanged: (params: any) => void
  magictypechanged: (params: any) => void
  pieselectchanged: (params: any) => void
  pieselected: (params: any) => void
  pieunselected: (params: any) => void
  mapselectchanged: (params: any) => void
  mapselected: (params: any) => void
  mapunselected: (params: any) => void
  geoselectchanged: (params: any) => void
  geoselected: (params: any) => void
  geounselected: (params: any) => void
  axisareaselected: (params: any) => void
  brush: (params: any) => void
  brushselected: (params: any) => void
  brushend: (params: { areas: Array<{ coordRange: [number, number]; brushType?: string; panelId?: string; range?: any }> }) => void
}

export interface ChartProps {
  echarts: typeof echarts
  options: StradaChartOption
  ref?: Ref<echarts.ECharts>
  optionUpdateBehavior?: SetOptionOpts
  className?: string
  isDarkMode?: boolean
  height?: number
  onEvents?: Partial<ChartEvents>
}

export function Chart({
  echarts,
  options,
  ref,
  optionUpdateBehavior,
  className,
  isDarkMode,
  height = 350,
  onEvents,
}: ChartProps) {
  const inferredIsDark = useIsDark()
  const resolvedIsDark = isDarkMode ?? inferredIsDark
  const elRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const handlersRef = useRef<Partial<ChartEvents>>({})
  const wrappersRef = useRef<Record<string, (params: any) => void>>({})
  const boundEventsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!elRef.current) return

    const chart = echarts.init(
      elRef.current,
      { color: getDefaultChartColors(resolvedIsDark) },
    )
    chartRef.current = chart

    if (typeof ref === 'function') ref(chart)
    else if (ref) ref.current = chart

    return () => {
      for (const event of boundEventsRef.current) {
        const wrapper = wrappersRef.current[event]
        if (wrapper) chart.off(event, wrapper)
      }
      boundEventsRef.current.clear()
      if (typeof ref === 'function') ref(null)
      else if (ref) ref.current = null
      chartRef.current = null
      chart.dispose()
    }
  }, [echarts, resolvedIsDark, ref])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.setOption(prepareChartOptions(options), { notMerge: false, lazyUpdate: true, ...optionUpdateBehavior })
  }, [optionUpdateBehavior, options])

  useEffect(() => {
    handlersRef.current = onEvents ?? {}
  }, [onEvents])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    const nextBound = new Set<string>()

    for (const [event, handler] of Object.entries(onEvents ?? {})) {
      if (typeof handler !== 'function') continue
      nextBound.add(event)

      if (!wrappersRef.current[event]) {
        wrappersRef.current[event] = (params: any) => {
          const handler = handlersRef.current[event]
          if (!handler) return
          handler(params)
        }
      }

      if (!boundEventsRef.current.has(event)) chart.on(event, wrappersRef.current[event])
    }

    for (const event of boundEventsRef.current) {
      if (nextBound.has(event)) continue
      const wrapper = wrappersRef.current[event]
      if (wrapper) chart.off(event, wrapper)
    }

    boundEventsRef.current = nextBound
  }, [onEvents])

  useEffect(() => {
    const chart = chartRef.current
    const el = elRef.current
    if (!chart || !el) return

    let isInitial = true
    const observer = new ResizeObserver(() => {
      if (isInitial) {
        isInitial = false
        return
      }
      chart.resize()
    })

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={elRef}
      className={cn('w-full', className)}
      style={{ height }}
      tabIndex={options.aria?.enabled ? 0 : undefined}
      role={options.aria?.enabled ? 'img' : undefined}
    />
  )
}

export interface TimeseriesChartProps extends Omit<BuildTimeseriesChartOptionOptions, 'echarts'> {
  echarts: typeof echarts
  height?: number
  onTimeRangeChange?: (from: number, to: number) => void
  loading?: boolean
}

export function TimeseriesChart({
  echarts,
  type = 'line',
  data,
  xAxisName,
  xAxisTickCount,
  xAxisTickFormat,
  yAxisTickFormat,
  yAxisTickLabelFormat,
  yAxisName,
  yAxisTickCount,
  tooltipValueFormat,
  onTimeRangeChange,
  height = 350,
  incomplete,
  isDarkMode,
  gradient,
  loading,
  ariaDescription,
  ariaEnabled,
}: TimeseriesChartProps) {
  const inferredIsDark = useIsDark()
  const resolvedIsDark = isDarkMode ?? inferredIsDark
  const chartRef = useRef<echarts.ECharts | null>(null)
  const options = useMemo(() => buildTimeseriesChartOption({
    echarts,
    type,
    data,
    xAxisName,
    xAxisTickCount,
    xAxisTickFormat,
    yAxisTickFormat,
    yAxisTickLabelFormat,
    yAxisName,
    yAxisTickCount,
    tooltipValueFormat,
    incomplete,
    gradient,
    ariaDescription,
    ariaEnabled,
    isDarkMode: resolvedIsDark,
  }), [
    ariaDescription,
    ariaEnabled,
    data,
    echarts,
    gradient,
    incomplete,
    resolvedIsDark,
    tooltipValueFormat,
    type,
    xAxisName,
    xAxisTickCount,
    xAxisTickFormat,
    yAxisName,
    yAxisTickCount,
    yAxisTickFormat,
    yAxisTickLabelFormat,
  ])

  const events = useMemo<Partial<ChartEvents>>(() => {
    if (!onTimeRangeChange) return {}
    return {
      brushend: (params) => {
        const range = params.areas[0].coordRange
        onTimeRangeChange(range[0], range[1])
        chartRef.current?.dispatchAction({ type: 'brush', areas: [] })
      },
    }
  }, [onTimeRangeChange])

  const hasTimeRangeCallback = !!onTimeRangeChange
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !hasTimeRangeCallback) return

    chart.dispatchAction({
      type: 'takeGlobalCursor',
      key: 'brush',
      brushOption: { brushType: 'lineX' as const, brushMode: 'single' as const },
    })

    return () => {
      chart.dispatchAction({ type: 'takeGlobalCursor', key: 'brush', brushOption: { brushType: false } })
    }
  }, [hasTimeRangeCallback, loading])

  return (
    <div className="relative w-full" style={{ height }}>
      {loading && <ChartWaveLoader height={height} isDarkMode={resolvedIsDark} />}
      {!loading && <Chart echarts={echarts} ref={chartRef} options={options} height={height} isDarkMode={resolvedIsDark} onEvents={events} />}
    </div>
  )
}

type LegendItemProps = {
  name: string
  color?: ChartColor
  value: string
  unit?: string
  inactive?: boolean
}

const LargeItem = function LargeItem({ color, value, name, unit, inactive }: LegendItemProps) {
  const isDark = useIsDark()
  const resolvedColor = resolveChartColor({ color, index: 0, isDarkMode: isDark })
  return (
    <div className="inline-flex min-w-42 flex-col gap-2 py-2">
      <div className="flex items-center gap-2">
        <span className={cn('inline-block size-2 rounded-full', inactive && 'opacity-50')} style={{ backgroundColor: resolvedColor }} />
        <span className={cn('text-xs', inactive && 'opacity-50')}>{name}</span>
      </div>
      <div className="flex items-baseline gap-0.5">
        <span className={cn('text-lg font-medium leading-none', inactive && 'opacity-50')}>{value}</span>
        {unit && <span className={cn('text-xs leading-none text-muted-foreground', inactive && 'opacity-50')}>{unit}</span>}
      </div>
    </div>
  )
}

const SmallItem = function SmallItem({ color, value, name, inactive }: LegendItemProps) {
  const isDark = useIsDark()
  const resolvedColor = resolveChartColor({ color, index: 0, isDarkMode: isDark })
  return (
    <div className="inline-flex items-center gap-2">
      <span className={cn('inline-block size-2 rounded-full', inactive && 'opacity-50')} style={{ backgroundColor: resolvedColor }} />
      <span className={cn('text-xs', inactive && 'opacity-50')}>{name}</span>
      <span className={cn('text-xs font-medium', inactive && 'opacity-50')}>{value}</span>
    </div>
  )
}

export const ChartLegend = {
  SmallItem,
  LargeItem,
}

function ChartWaveLoader({ height, isDarkMode }: { height: number; isDarkMode?: boolean }) {
  const mid = height / 2
  const amp = Math.min(height * 0.12, 28)
  const period = 400
  const steps = 120
  const points: string[] = []

  for (let i = 0; i <= steps; i++) {
    const x = -period + (i / steps) * period * 3
    const y = mid + Math.sin((i / steps) * 2 * Math.PI * 3) * amp
    points.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
  }

  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden" style={{ height }}>
      <svg width="100%" height={height} viewBox={`0 0 ${period} ${height}`} preserveAspectRatio="none" className="w-full animate-pulse">
        <path
          d={points.join(' ')}
          fill="none"
          stroke={isDarkMode ? 'var(--muted-foreground)' : 'var(--border)'}
          strokeWidth="2"
          style={{ animation: 'strada-chart-wave 2.4s linear infinite', transformOrigin: '0 0' }}
        />
      </svg>
    </div>
  )
}
