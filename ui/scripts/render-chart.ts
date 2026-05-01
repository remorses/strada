/**
 * Renders a shared Strada UI ECharts option to PNG in Node.js using
 * @napi-rs/canvas. This proves the chart config can be reused by CLI code.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Canvas, Image, createCanvas } from '@napi-rs/canvas'
import { BarChart, LineChart } from 'echarts/charts'
import {
  AriaComponent,
  AxisPointerComponent,
  BrushComponent,
  GridComponent,
  ToolboxComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'

import { getDefaultChartColors } from '../src/lib/chart-palette.ts'
import { buildTimeseriesChartOption, prepareChartOptions, type TimeseriesData } from '../src/lib/echarts-options.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const outputPath = path.join(repoRoot, 'tmp/strada-ui-chart-example.png')

echarts.use([
  LineChart,
  BarChart,
  AxisPointerComponent,
  BrushComponent,
  GridComponent,
  ToolboxComponent,
  TooltipComponent,
  CanvasRenderer,
  AriaComponent,
])

installCanvasGlobals()

const width = 960
const height = 420
const isDarkMode = true

console.log(`Creating ${width}x${height} canvas`)
const canvas = createCanvas(width, height)
// @ts-expect-error @napi-rs/canvas implements the browser canvas methods ECharts uses in Node.
const chart = echarts.init(canvas, { color: getDefaultChartColors(isDarkMode) }, {
  renderer: 'canvas',
  devicePixelRatio: 2,
  width,
  height,
})

try {
  console.log('Building shared timeseries chart option')
  const options = buildTimeseriesChartOption({
    echarts,
    data: buildExampleData(),
    gradient: true,
    isDarkMode,
    colorMode: 'static',
    ariaEnabled: false,
    xAxisName: 'Time',
    yAxisName: 'Requests',
    tooltipValueFormat: (value) => `${value.toFixed(0)} req/s`,
    ariaDescription: 'Example Strada requests and errors timeseries chart rendered in Node.js',
  })
  options.backgroundColor = 'transparent'

  console.log('Rendering ECharts option to canvas')
  chart.setOption(prepareChartOptions(options), { notMerge: true, lazyUpdate: false })

  console.log(`Writing ${outputPath}`)
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, await canvas.encode('png'))

  console.log(`Rendered chart image: ${outputPath}`)
} finally {
  chart.dispose()
}

function installCanvasGlobals() {
  Object.assign(globalThis, {
    Canvas,
    HTMLCanvasElement: Canvas,
    Image,
    HTMLImageElement: Image,
  })

  echarts.setPlatformAPI({
    // @ts-expect-error @napi-rs/canvas is compatible with ECharts' platform canvas contract.
    createCanvas: () => createCanvas(32, 32),
    loadImage(src, onload, onerror) {
      const image = new Image()
      image.onload = onload.bind(image)
      image.onerror = onerror.bind(image)
      image.src = src
      return image
    },
  })
}

function buildExampleData(): TimeseriesData[] {
  const start = Date.UTC(2026, 0, 1, 12, 0, 0)
  const timestamps = Array.from({ length: 36 }, (_, index) => start + index * 60_000)
  const point = (timestamp: number, value: number): [number, number] => [timestamp, value]

  return [
    {
      name: 'Requests',
      color: 'blue',
      data: timestamps.map((timestamp, index) => point(timestamp, 120 + Math.sin(index / 3) * 42 + index * 2.5)),
    },
    {
      name: 'Errors',
      color: 'red',
      data: timestamps.map((timestamp, index) => point(timestamp, 8 + Math.cos(index / 2) * 4)),
    },
  ]
}
