'use client'

import { areaY, barY, defineChart, lineY, stack } from '@tanstack/charts'
import { crosshair } from '@tanstack/charts/crosshair'
import { Chart } from '@tanstack/charts/react/tooltip'
import { scaleBand } from '@tanstack/charts/scales/band'
import { scaleLinear } from '@tanstack/charts/scales/linear'
import { tooltip } from '@tanstack/charts/tooltip'
import { portal } from '@tanstack/charts/tooltip/portal'
import { scaleUtc } from 'd3-scale'
import { useMemo, type ReactNode } from 'react'
import { chartCursor, COLORS, cursorHost } from '../lib/chart-colors.ts'
import { RANGE_END, RANGE_START, type TimePoint } from '../lib/metrics-data.ts'
import { cn, formatTickTime, formatTooltipTime } from '../lib/utils.ts'
import { ChartTooltip } from './chart-tooltip.tsx'

export type SeriesSpec = {
  key: string
  label: string
  color: string
  kind?: 'bar' | 'area' | 'line'
  fillOpacity?: number
  strokeWidth?: number
}

const TICK_TIMES = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60].map(
  (minute) => new Date(RANGE_START.getTime() + minute * 60_000),
)

function timeXAxis() {
  return {
    scale: () => scaleUtc().domain([RANGE_START, RANGE_END]),
    axis: {
      line: { stroke: 'var(--border)', strokeOpacity: 0.8 },
      ticks: {
        values: TICK_TIMES,
        size: 0,
        padding: 7,
        format: (value: Date) => formatTickTime(value),
      },
      tickLabels: {
        fontSize: 11,
        opacity: 0.9,
        thin: { minGap: 8, priority: 'ends' as const },
      },
    },
  }
}

function yAxis(
  [format, ticks, domainMax, dataMax]: [
    ((value: number) => string) | undefined,
    number[] | undefined,
    number | undefined,
    number,
  ],
) {
  const requestedMax = Math.max(domainMax ?? 0, ticks?.at(-1) ?? 0)
  const max = dataMax > requestedMax ? dataMax * 1.08 : requestedMax
  const min = Math.min(ticks?.[0] ?? 0, 0)
  return {
    scale: scaleLinear().domain([min, max || 1]),
    nice: false,
    grid: { stroke: 'var(--border)', strokeOpacity: 0.75, strokeWidth: 1 },
    axis: {
      line: false,
      ticks: {
        values: ticks,
        size: 0,
        padding: 7,
        format: format ?? ((value: number) => String(value)),
      },
      tickLabels: {
        fontSize: 11,
        opacity: 0.9,
      },
    },
  }
}

function valueOf(row: TimePoint, key: string) {
  return Number(row[key] ?? 0)
}

export function TimeSeriesChart({
  data,
  series,
  ariaLabel,
  height = 168,
  yFormat,
  valueFormat,
  yTicks,
  domainMax,
  stacked,
}: {
  data: readonly TimePoint[]
  series: readonly SeriesSpec[]
  ariaLabel: string
  height?: number
  yFormat?: (value: number) => string
  valueFormat?: (value: number) => string
  yTicks?: number[]
  domainMax?: number
  stacked?: boolean
}) {
  const definition = useMemo(() => {
    const colorRange = series.map((item) => item.color)
    const colorDomain = series.map((item) => item.key)
    const hasBar = series.some((item) => item.kind === 'bar')
    const dataMax = Math.max(
      0,
      ...data.map((row) =>
        stacked
          ? series.reduce((sum, item) => sum + Math.max(0, valueOf(row, item.key)), 0)
          : Math.max(...series.map((item) => valueOf(row, item.key))),
      ),
    )

    const marks = stacked
      ? [
          barY(
            series.flatMap((item) =>
              data.map((row) => ({
                time: row.time,
                series: item.key,
                value: valueOf(row, item.key),
              })),
            ),
            {
              x: 'time',
              y: 'value',
              z: 'series',
              color: 'series',
              layout: stack({ order: colorDomain }),
            },
          ),
        ]
      : series.flatMap((item) => {
          const rows = data.map((row) => ({
            time: row.time,
            value: valueOf(row, item.key),
            series: item.key,
          }))
          const kind = item.kind ?? 'line'
          if (kind === 'bar') {
            return [
              barY(rows, {
                x: 'time',
                y: 'value',
                fill: item.color,
                fillOpacity: item.fillOpacity ?? 1,
              }),
            ]
          }
          if (kind === 'area') {
            return [
              areaY(rows, {
                x: 'time',
                y1: 0,
                y2: 'value',
                fill: item.color,
                fillOpacity: item.fillOpacity ?? 0.22,
              }),
              lineY(rows, {
                x: 'time',
                y: 'value',
                stroke: item.color,
                strokeWidth: item.strokeWidth ?? 1.5,
              }),
            ]
          }
          return [
            lineY(rows, {
              x: 'time',
              y: 'value',
              stroke: item.color,
              strokeWidth: item.strokeWidth ?? 1.8,
            }),
          ]
        })

    return defineChart({
      marks: [...marks, crosshair({ x: {}, y: false })],
      scales: {
        x: timeXAxis(),
        y: yAxis([yFormat, yTicks, domainMax, dataMax]),
      },
      color: { domain: colorDomain, range: colorRange },
      margin: { top: 10, right: 42, bottom: 24, left: 44 },
      clip: hasBar,
      theme: {
        foreground: 'var(--muted-foreground)',
        muted: 'var(--muted-foreground)',
        grid: 'var(--border)',
        background: 'transparent',
      },
      focus: 'group-x',
      maxFocusDistance: Number.POSITIVE_INFINITY,
      cursor: {
        use: cursorHost,
        controller: chartCursor,
        mode: 'focus',
        match: 'x',
      },
      tooltip: { use: tooltip, portal, className: 'metrics-tooltip' },
    })
  }, [data, domainMax, series, stacked, yFormat, yTicks])

  return (
    <div className="relative overflow-hidden">
      <Chart
        definition={definition}
        height={height}
        ariaLabel={ariaLabel}
        renderTooltipBody={({ points }) => {
          const time = points[0]?.datum.time
          if (!time) return null
          const rows = series.map((item) => {
              const point = points.find((entry) => entry.datum.series === item.key)
              const fallback = data.find((row) => row.time.getTime() === time.getTime())
              const value = Number(point?.datum.value ?? (fallback ? valueOf(fallback, item.key) : 0))
              return {
                color: item.color,
                label: item.label,
                value: valueFormat
                  ? valueFormat(value)
                  : value.toLocaleString('en-US', { maximumFractionDigits: 2 }),
              }
            })
          return <ChartTooltip time={formatTooltipTime(time)} rows={rows} />
        }}
      />
    </div>
  )
}

export function CategoryBarChart({
  rows,
  ariaLabel,
  height = 168,
  yFormat,
  yTicks,
  domainMax,
  xFormat,
}: {
  rows: readonly { x: string; series: string; value: number }[]
  ariaLabel: string
  height?: number
  yFormat?: (value: number) => string
  yTicks?: number[]
  domainMax?: number
  xFormat?: (value: string) => string
}) {
  const seriesNames = [...new Set(rows.map((row) => row.series))]
  const colors = seriesNames.map((name) => (name === 'CPU' ? COLORS.usageCpu : COLORS.usageMemory))
  const categories = [...new Set(rows.map((row) => row.x))]
  const dataMax = Math.max(
    0,
    ...categories.map((category) =>
      rows.filter((row) => row.x === category).reduce((sum, row) => sum + Math.max(0, row.value), 0),
    ),
  )
  const definition = useMemo(() => {
    return defineChart({
      marks: [
        barY(rows, {
          x: 'x',
          y: 'value',
          z: 'series',
          color: 'series',
          radius: { end: 2, stack: 'outer' },
        }),
      ],
      scales: {
        x: {
          scale: () => scaleBand<string>().padding(0.34),
          axis: {
            ticks: {
              size: 0,
              format: (value: string) => (xFormat ? xFormat(value) : value),
            },
          },
        },
        y: yAxis([yFormat, yTicks, domainMax, dataMax]),
      },
      color: {
        domain: seriesNames,
        range: colors,
      },
      margin: { top: 12, right: 12, bottom: 24, left: 48 },
      clip: true,
      focus: 'group-x',
      maxFocusDistance: Number.POSITIVE_INFINITY,
      tooltip: { use: tooltip, portal, className: 'metrics-tooltip' },
      theme: {
        foreground: 'var(--muted-foreground)',
        muted: 'var(--muted-foreground)',
        grid: 'var(--border)',
        background: 'transparent',
      },
    })
  }, [colors, dataMax, domainMax, rows, seriesNames, xFormat, yFormat, yTicks])

  return (
    <div className="overflow-hidden">
      <Chart
        definition={definition}
        height={height}
        ariaLabel={ariaLabel}
        renderTooltipBody={({ points }) => {
          const heading = points[0]?.xValue
          return (
            <ChartTooltip
              time={String(heading ?? '')}
              rows={points.map((point) => ({
                color: colors[seriesNames.indexOf(String(point.datum.series))] ?? COLORS.usageCpu,
                label: String(point.datum.series),
                value: yFormat ? yFormat(point.datum.value) : String(point.datum.value),
              }))}
            />
          )
        }}
      />
    </div>
  )
}

export function PercentileChart({
  rows,
  ariaLabel,
  height = 168,
}: {
  rows: readonly { duration: number; percentile: number }[]
  ariaLabel: string
  height?: number
}) {
  const definition = useMemo(() => {
    return defineChart({
      marks: [
        lineY(rows, {
          x: 'duration',
          y: 'percentile',
          stroke: COLORS.p50,
          strokeWidth: 2,
        }),
      ],
      scales: {
        x: {
          scale: scaleLinear().domain([0, 19320]),
          axis: {
            ticks: {
              values: [100, 1000, 9960],
              size: 0,
              format: (value: number) => {
                if (value < 120) return '1m 40s'
                if (value < 2000) return '16m 40s'
                return '2h 46m'
              },
            },
          },
        },
        y: {
          scale: scaleLinear().domain([0, 100]),
          axis: {
            ticks: {
              values: [0, 50, 100],
              size: 0,
              format: (value: number) => `${value}%`,
            },
          },
        },
      },
      margin: { top: 10, right: 16, bottom: 22, left: 40 },
      theme: {
        foreground: 'var(--muted-foreground)',
        muted: 'var(--muted-foreground)',
        grid: 'var(--border)',
        background: 'transparent',
      },
      tooltip: { use: tooltip, visibility: 'pinned' },
    })
  }, [rows])

  return (
    <div className="overflow-hidden">
      <Chart definition={definition} height={height} ariaLabel={ariaLabel} />
    </div>
  )
}

export function ChartGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-1 gap-4 md:grid-cols-2', className)}>{children}</div>
}
