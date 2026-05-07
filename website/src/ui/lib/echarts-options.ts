/**
 * Pure ECharts option builders shared by React chart components and Node.js
 * canvas rendering scripts. This file must stay free of React and DOM imports.
 */
import type { EChartsOption, TooltipComponentOption } from 'echarts'
import type * as echarts from 'echarts/core'

import { resolveChartColor, type ChartColor } from './chart-palette.ts'

export type SafeTooltipOption = Omit<TooltipComponentOption, 'formatter'> & {
  dangerousHtmlFormatter?: TooltipComponentOption['formatter']
}

export type StradaChartOption = {
  [K in keyof EChartsOption]: K extends 'tooltip'
    ? SafeTooltipOption | SafeTooltipOption[] | undefined
    : EChartsOption[K]
}

export interface TimeseriesData {
  name: string
  data: [number, number][]
  color?: ChartColor
}

export interface BuildTimeseriesChartOptionOptions {
  echarts: Pick<typeof echarts, 'graphic' | 'format'>
  type?: 'line' | 'bar'
  data: TimeseriesData[]
  xAxisName?: string
  xAxisTickCount?: number
  xAxisTickFormat?: (value: number) => string
  yAxisTickFormat?: (value: number) => string
  yAxisTickLabelFormat?: (value: number) => string
  yAxisName?: string
  yAxisTickCount?: number
  tooltipValueFormat?: (value: number) => string
  incomplete?: { before?: number; after?: number }
  gradient?: boolean
  ariaDescription?: string
  ariaEnabled?: boolean
  colorMode?: 'css' | 'static'
  isDarkMode?: boolean
}

export function prepareChartOptions(options: StradaChartOption): EChartsOption {
  const defaults = {
    animation: options.animation ?? false,
  }

  if (!options.tooltip) return { ...defaults, ...options }
  return {
    ...defaults,
    ...options,
    tooltip: Array.isArray(options.tooltip)
      ? options.tooltip.map(transformTooltip)
      : transformTooltip(options.tooltip),
  }
}

export function buildTimeseriesChartOption({
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
  incomplete,
  gradient,
  ariaDescription,
  ariaEnabled = true,
  colorMode = 'css',
  isDarkMode,
}: BuildTimeseriesChartOptionOptions): StradaChartOption {
  const series: any[] = []
  const theme = getChartThemeColors({ colorMode, isDarkMode })
  const incompleteBefore = incomplete?.before
  const incompleteAfter = incomplete?.after
  const seriesType = type === 'bar'
    ? ({ type: 'bar', stack: 'total' } as const)
    : ({
        type: 'line',
        showSymbol: false,
        smooth: false,
        lineStyle: {
          cap: 'butt' as const,
          join: 'miter' as const,
          miterLimit: 10,
        },
      } as const)

  for (const [index, item] of data.entries()) {
    const color = resolveChartColor({ color: item.color, index, isDarkMode })
    const incompleteBeforePoints = incompleteBefore && type === 'line' ? item.data.filter((point) => point[0] <= incompleteBefore) : []
    const incompleteAfterPoints = incompleteAfter && type === 'line' ? item.data.filter((point) => point[0] >= incompleteAfter) : []
    const completePoints = incompleteBeforePoints.length > 0 || incompleteAfterPoints.length > 0
      ? item.data.slice(
          Math.max(0, incompleteBeforePoints.length - 1),
          Math.max(0, item.data.length - incompleteAfterPoints.length + 1),
        )
      : item.data

    const areaStyle = gradient && type === 'line'
      ? {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: colorWithOpacity(color, 0.4) },
            { offset: 1, color: colorWithOpacity(color, 0) },
          ]),
        }
      : undefined

    series.push({
      data: completePoints,
      color,
      name: item.name,
      emphasis: { focus: 'series' },
      ...(areaStyle ? { areaStyle } : {}),
      ...seriesType,
    })

    const incompleteSeriesConfig = {
      color,
      name: item.name,
      type: 'line' as const,
      lineStyle: {
        type: 'dashed' as const,
        cap: 'butt' as const,
        join: 'miter' as const,
        miterLimit: 10,
      },
      showSymbol: false,
      smooth: false,
      emphasis: { focus: 'series' as const },
    }

    if (incompleteBeforePoints.length > 0) series.push({ ...incompleteSeriesConfig, data: incompleteBeforePoints })
    if (incompleteAfterPoints.length > 0) series.push({ ...incompleteSeriesConfig, data: incompleteAfterPoints })
  }

  return {
    aria: { enabled: ariaEnabled, ...(ariaDescription && { label: { description: ariaDescription } }) },
    brush: {
      xAxisIndex: 'all' as const,
      brushType: 'lineX' as const,
      brushMode: 'single' as const,
      outOfBrush: { colorAlpha: 0.3 },
      brushStyle: {
        borderWidth: 1,
        color: theme.brushFill,
        borderColor: theme.brushBorder,
      },
    },
    tooltip: {
      trigger: 'axis' as const,
      appendTo: 'body',
      axisPointer: { type: 'shadow' as const },
      backgroundColor: theme.popover,
      borderColor: theme.border,
      textStyle: { color: theme.popoverForeground },
      dangerousHtmlFormatter: (params) => {
        const items = Array.isArray(params) ? params : [params]
        const seenNames = new Set<string>()
        const filteredParams = items.filter((param) => {
          const name = String(param.seriesName)
          if (seenNames.has(name)) return false
          seenNames.add(name)
          return true
        })
        const first = filteredParams[0]
        const ts = Array.isArray(first?.value) ? first.value[0] : (first as any)?.axisValue
        const header = ts != null
          ? `<div style="font-weight:600;margin-bottom:4px;">${echarts.format.encodeHTML(formatTimestamp(ts))}</div>`
          : ''
        const rows = filteredParams.map((param) => {
          const value = Array.isArray(param?.value) ? Number(param.value[1]) : Number(param?.value)
          const formatFn = tooltipValueFormat ?? yAxisTickLabelFormat
          const formattedValue = formatFn ? formatFn(value) : String(value)
          return `${param.marker} ${echarts.format.encodeHTML(String(param.seriesName))}: <strong>${echarts.format.encodeHTML(formattedValue)}</strong>`
        }).join('<br/>')

        return `${header}${rows}`
      },
    },
    backgroundColor: 'transparent',
    toolbox: { show: false },
    xAxis: {
      name: xAxisName,
      nameLocation: 'middle' as const,
      nameGap: 30,
      nameTextStyle: { color: theme.mutedForeground },
      type: 'time' as const,
      min: 'dataMin',
      max: 'dataMax',
      splitLine: { show: false },
      axisLine: { show: false },
      splitNumber: xAxisTickCount ?? 5,
      axisLabel: {
        color: theme.mutedForeground,
        hideOverlap: true,
        ...(xAxisTickFormat && { formatter: (value: number) => xAxisTickFormat(value) }),
      },
    },
    yAxis: {
      name: yAxisName,
      nameLocation: 'middle' as const,
      nameGap: 40,
      nameTextStyle: { color: theme.mutedForeground },
      type: 'value' as const,
      axisTick: { show: true },
      axisLabel: {
        color: theme.mutedForeground,
        margin: 15,
        ...(yAxisTickFormat && { formatter: (value: number) => yAxisTickFormat(value) }),
      },
      splitLine: { show: true, lineStyle: { type: 'dashed' as const, width: 1, color: theme.gridLine } },
      splitNumber: yAxisTickCount,
    },
    grid: { left: yAxisName ? 30 : 24, right: 0, top: 24, bottom: xAxisName ? 30 : 24 },
    series,
  }
}

const transformTooltip = (tooltip: SafeTooltipOption) => {
  const { dangerousHtmlFormatter, ...rest } = tooltip
  const extraCssText = [rest.extraCssText, 'box-shadow: none'].filter(Boolean).join('; ')
  return { ...rest, extraCssText, formatter: dangerousHtmlFormatter }
}

function getChartThemeColors({ colorMode, isDarkMode }: Pick<BuildTimeseriesChartOptionOptions, 'colorMode' | 'isDarkMode'>) {
  if (colorMode !== 'static') {
    return {
      popover: 'var(--popover)',
      popoverForeground: 'var(--popover-foreground)',
      border: 'var(--border)',
      brushFill: 'color-mix(in srgb, var(--primary) 20%, transparent)',
      brushBorder: 'color-mix(in srgb, var(--primary) 60%, transparent)',
      mutedForeground: isDarkMode ? '#999999' : '#737373',
      gridLine: isDarkMode ? '#393939' : '#e2e2e2',
    }
  }

  return isDarkMode
    ? {
        popover: '#272727',
        popoverForeground: '#f4f4f4',
        border: '#393939',
        brushFill: 'rgba(244, 244, 244, 0.2)',
        brushBorder: 'rgba(244, 244, 244, 0.6)',
        mutedForeground: '#c7c7c7',
        gridLine: '#393939',
      }
    : {
        popover: '#ffffff',
        popoverForeground: '#1f1f1f',
        border: '#e2e2e2',
        brushFill: 'rgba(64, 64, 64, 0.2)',
        brushBorder: 'rgba(64, 64, 64, 0.6)',
        mutedForeground: '#525252',
        gridLine: '#e2e2e2',
      }
}

function colorWithOpacity(color: string, alpha: number): string {
  const opacity = Math.max(0, Math.min(1, alpha))
  const rgbMatch = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i)
  if (rgbMatch) return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${opacity})`

  let hex = color.replace(/^#/, '')
  if (hex.length === 3) hex = hex[0]! + hex[0]! + hex[1]! + hex[1]! + hex[2]! + hex[2]!
  if (hex.length === 8) hex = hex.slice(0, 6)
  if (!/^[\da-f]{6}$/i.test(hex)) return color

  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${opacity})`
}

function formatTimestamp(ts: number | string | Date): string {
  const date = new Date(ts)
  const pad = (value: number) => value.toString().padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
