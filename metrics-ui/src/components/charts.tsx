'use client'

import { areaY, barY, defineChart, lineY, stack } from '@tanstack/charts'
import { crosshair } from '@tanstack/charts/crosshair'
import { Chart } from '@tanstack/charts/react/tooltip'
import { scaleBand } from '@tanstack/charts/scales/band'
import { scaleLinear } from '@tanstack/charts/scales/linear'
import { tooltip } from '@tanstack/charts/tooltip'
import { scaleUtc } from 'd3-scale'
import { useMemo, type ReactNode } from 'react'
import { chartCursor, COLORS, cursorHost } from '../lib/chart-colors.ts'
import type { TimePoint } from '../lib/mock-data.ts'
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

const DAY_MS = 86_400_000

// Buckets of a day or more (analytics, usage) show dates instead of clock times.
function isDaily(data: readonly TimePoint[]) {
  const first = data[0]?.time.getTime() ?? 0
  const second = data[1]?.time.getTime() ?? first
  return second - first >= DAY_MS
}

// Bars are centered on their timestamp, so pad the domain by half a bucket to keep
// the first and last bars inside the plot instead of overlapping the y axis labels.
function timeXAxis(data: readonly TimePoint[], hasBar: boolean) {
  const start = data[0]?.time.getTime() ?? 0
  const end = data.at(-1)?.time.getTime() ?? start
  const half = hasBar ? ((data[1]?.time.getTime() ?? start) - start) / 2 : 0
  const daily = isDaily(data)
  const scale = scaleUtc().domain([new Date(start - half), new Date(end + half)])
  // Pass the instance, not a factory: factories get their domain re-inferred from data.
  return {
    scale,
    axis: {
      line: { stroke: 'var(--border)', strokeOpacity: 0.8 },
      ticks: {
        values: scale.ticks(daily ? 6 : 8),
        size: 0,
        padding: 7,
        format: (value: Date) => formatTickTime(value, daily),
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
  margin,
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
  margin?: { top: number; right: number; bottom: number; left: number }
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
      marks: [
        ...marks,
        crosshair({
          x: {
            stroke: 'var(--foreground)',
            strokeOpacity: 0.16,
            strokeWidth: 1,
            band: hasBar
              ? { fill: 'var(--border)', fillOpacity: 0.85, inset: 0 }
              : false,
          },
          y: false,
          marker: {
            radius: 3.5,
            fill: 'var(--background)',
            strokeWidth: 1.5,
          },
        }),
      ],
      scales: {
        x: timeXAxis(data, hasBar),
        y: yAxis([yFormat, yTicks, domainMax, dataMax]),
      },
      color: { domain: colorDomain, range: colorRange },
      margin: margin ?? { top: 8, right: 16, bottom: 24, left: 36 },
      clip: false,
      theme: {
        foreground: 'var(--muted-foreground)',
        muted: 'var(--muted-foreground)',
        grid: 'var(--border)',
        background: 'transparent',
      },
      focus: 'group-x',
      focusRing: false,
      maxFocusDistance: Number.POSITIVE_INFINITY,
      cursor: {
        use: cursorHost,
        controller: chartCursor,
        mode: 'focus',
        match: 'x',
      },
      tooltip: { use: tooltip, className: 'metrics-tooltip' },
    })
  }, [data, domainMax, margin, series, stacked, yFormat, yTicks])

  return (
    <div className="relative">
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
          return <ChartTooltip time={formatTooltipTime(time, isDaily(data))} rows={rows} />
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
  colors: colorMap,
}: {
  rows: readonly { x: string; series: string; value: number }[]
  colors: Record<string, string>
  ariaLabel: string
  height?: number
  yFormat?: (value: number) => string
  yTicks?: number[]
  domainMax?: number
  xFormat?: (value: string) => string
}) {
  const seriesNames = [...new Set(rows.map((row) => row.series))]
  const colors = seriesNames.map((name) => colorMap[name] ?? COLORS.primary)
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
      clip: false,
      focus: 'group-x',
      focusRing: false,
      maxFocusDistance: Number.POSITIVE_INFINITY,
      tooltip: { use: tooltip, className: 'metrics-tooltip' },
      theme: {
        foreground: 'var(--muted-foreground)',
        muted: 'var(--muted-foreground)',
        grid: 'var(--border)',
        background: 'transparent',
      },
    })
  }, [colors, dataMax, domainMax, rows, seriesNames, xFormat, yFormat, yTicks])

  return (
    <div className="relative">
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
                color: colors[seriesNames.indexOf(String(point.datum.series))] ?? COLORS.primary,
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

export function ChartGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-1 gap-4 md:grid-cols-2', className)}>{children}</div>
}
