export const APP_NAME = 'synmon-exit-snapshot'
export const FUNCTION_NAME = 'run_one'
export const FUNCTION_QUALIFIED = 'app.run_one'

export const RANGE_START = new Date('2026-09-10T20:05:00.000Z')
export const RANGE_END = new Date('2026-09-10T21:05:00.000Z')
export const CURSOR_TIME = new Date('2026-09-10T20:36:00.000Z')

export type TimePoint = {
  time: Date
  [key: string]: Date | number
}

function hashNoise(index: number, seed: number) {
  const value = Math.sin(index * 12.9898 + seed * 78.233) * 43758.5453
  return value - Math.floor(value)
}

function wave([index, seed, amplitude]: [number, number, number]) {
  return (
    Math.sin(index / 4.2 + seed) * amplitude +
    Math.sin(index / 9.5 + seed * 1.7) * amplitude * 0.45 +
    (hashNoise(index, seed) - 0.5) * amplitude * 0.35
  )
}

function step([index, before, after, at = 10]: [number, number, number, number?]) {
  return index < at ? before : after
}

const minuteCount = Math.round((RANGE_END.getTime() - RANGE_START.getTime()) / 60_000) + 1

export const minuteTimes = Array.from(
  { length: minuteCount },
  (_, index) => new Date(RANGE_START.getTime() + index * 60_000),
)

export const functionCallResults: TimePoint[] = minuteTimes.map((time, index) => {
  const burst = index % 3 === 0 || index % 7 === 0
  const quiet = index > 33 && index < 48
  const value = quiet ? 0 : burst ? Math.round(1 + hashNoise(index, 2) * 3) : hashNoise(index, 4) > 0.72 ? 1 : 0
  return { time, success: index === 31 ? 2 : value }
})

export const containerSeries: TimePoint[] = minuteTimes.map((time, index) => {
  const live = Math.round(step([index, 498, 718]) + (index >= 10 ? 3 : 0) + wave([index, 1, 1.2]))
  if (index === 31) return { time, live: 721, total: 721 }
  return { time, live, total: live }
})

export const cpuSeries: TimePoint[] = minuteTimes.map((time, index) => ({
  time,
  request: step([index, 62.4, 90.04]),
  used: index === 31 ? 0.44 : 0.38 + Math.abs(wave([index, 3, 0.08])),
}))

export const memorySeries: TimePoint[] = minuteTimes.map((time, index) => ({
  time,
  request: step([index, 62.4, 90.04]),
  used: index === 31 ? 23.73 : 23.4 + wave([index, 5, 0.35]),
}))

export const networkSeries: TimePoint[] = minuteTimes.map((time, index) => {
  const spike = [2, 8, 14, 22, 24].includes(index)
  if (index === 31) return { time, egress: 0, ingress: 0 }
  return {
    time,
    egress: spike ? 40 + hashNoise(index, 8) * 90 : hashNoise(index, 9) * 6,
    ingress: spike && index % 8 === 0 ? 18 : 0,
  }
})

export const taskRegistrySeries: TimePoint[] = minuteTimes.map((time, index) => {
  const slots = step([index, 18, 51])
  return { time, green: slots, target: slots }
})

export const pendingCallsSeries: TimePoint[] = minuteTimes.map((time, index) => ({
  time,
  average: index === 31 ? 0 : index === 10 ? 24.2 : index === 9 || index === 11 ? 6 : 0.12,
  maximum: index === 31 ? 0 : index === 10 ? 24.2 : 0.4,
}))

export const runningCallsSeries: TimePoint[] = minuteTimes.map((time, index) => {
  const average = step([index, 497, 719.7]) + wave([index, 6, 0.4])
  if (index === 31) return { time, average: 719.7, maximum: 720 }
  return { time, average, maximum: average + 0.3 }
})

export const executionTimeSeries: TimePoint[] = minuteTimes.map((time, index) => {
  const p50 = 4.4 * 3600 + wave([index, 7, 1600])
  if (index === 31) return { time, p50: 19320, p90: 19320 }
  return { time, p50: Math.max(2.8 * 3600, p50), p90: Math.max(3 * 3600, p50 + 120) }
})

export const executionPercentiles = [
  { duration: 100, percentile: 2 },
  { duration: 1000, percentile: 4 },
  { duration: 2500, percentile: 6 },
  { duration: 5000, percentile: 9 },
  { duration: 7200, percentile: 12 },
  { duration: 9000, percentile: 16 },
  { duration: 9960, percentile: 22 },
  { duration: 12000, percentile: 28 },
  { duration: 14000, percentile: 38 },
  { duration: 15500, percentile: 52 },
  { duration: 16800, percentile: 68 },
  { duration: 17800, percentile: 82 },
  { duration: 18600, percentile: 92 },
  { duration: 19320, percentile: 100 },
]

export const sandboxCreated: TimePoint[] = minuteTimes.map((time, index) => ({
  time,
  created: index === 31 ? 2 : index === 10 ? 68 : hashNoise(index, 11) > 0.55 ? 1 + Math.round(hashNoise(index, 12)) : 0,
}))

export const sandboxSeries: TimePoint[] = minuteTimes.map((time, index) => {
  const live = Math.round(step([index, 496, 718]) + wave([index, 1.4, 1.1]))
  if (index === 31) return { time, live: 720, total: 720 }
  return { time, live, total: live }
})

export const sandboxLifetime: TimePoint[] = minuteTimes.map((time, index) => {
  const p50 = 1.4 * 3600 + Math.abs(wave([index, 8, 2400]))
  const p90 = 2.8 * 3600 + Math.abs(wave([index, 9, 3200]))
  if (index === 31) return { time, p50: 9660, p90: 19320 }
  return { time, p50, p90: Math.max(p90, p50 + 600) }
})

export const sandboxCpu: TimePoint[] = minuteTimes.map((time, index) => ({
  time,
  request: step([index, 62.1, 89.91]),
  used: index === 31 ? 6.22 : 5.8 + wave([index, 10, 0.5]),
}))

export const sandboxCpuPer: TimePoint[] = minuteTimes.map((time, index) => ({
  time,
  request: 0.125,
  p75: index === 31 ? 0.009 : 0.0088 + wave([index, 11, 0.0006]),
  p50: index === 31 ? 0.008 : 0.0076 + wave([index, 12, 0.0005]),
}))

export const sandboxMemory: TimePoint[] = minuteTimes.map((time, index) => ({
  time,
  request: step([index, 62.1, 89.91]),
  used: index === 31 ? 5.94 : 5.7 + wave([index, 13, 0.28]),
}))

export const sandboxMemoryPer: TimePoint[] = minuteTimes.map((time, index) => ({
  time,
  request: 128,
  p99: index === 31 ? 23.37 : 23.1 + wave([index, 14, 0.4]),
  p95: index === 31 ? 15.16 : 15.0 + wave([index, 15, 0.3]),
  p90: index === 31 ? 8.82 : 8.6 + wave([index, 16, 0.25]),
}))

export const timeToStarted: TimePoint[] = minuteTimes.map((time, index) => ({
  time,
  p90: index === 31 ? 1.51 : 1.15 + Math.abs(wave([index, 17, 0.45])),
  p50: index === 31 ? 1.18 : 0.85 + Math.abs(wave([index, 18, 0.22])),
}))

export const sandboxNetwork: TimePoint[] = minuteTimes.map((time) => ({
  time,
  egress: 0.4,
  ingress: 0.2,
}))

export type UsageBar = {
  time: Date
  series: 'CPU' | 'Memory'
  value: number
}

export const lastHourUsage: UsageBar[] = minuteTimes.flatMap((time, index) => {
  const cooling = index > 48
  const cpu = index === 31 ? 0.43 : cooling ? 0.38 : 0.43 + (index > 10 ? 0.02 : 0)
  const memory = index === 31 ? 0.07 : cooling ? 0.06 : 0.07
  return [
    { time, series: 'CPU', value: cpu },
    { time, series: 'Memory', value: memory },
  ]
})

const cycleDays = [
  ['Wed 02', 612, 92],
  ['Thu 03', 618, 94],
  ['Fri 04', 498, 78],
  ['Sat 05', 602, 88],
  ['Sun 06', 574, 84],
  ['Mon 07', 628, 91],
  ['Tue 08', 641, 93],
  ['Wed 09', 598, 87],
  ['Thu 10', 521.71, 88.24],
] as const

export const cycleUsage = cycleDays.flatMap(([day, cpu, memory]) => [
  { day, series: 'CPU' as const, value: cpu },
  { day, series: 'Memory' as const, value: memory },
])

export const functionCosts = [
  { name: FUNCTION_QUALIFIED, amount: 3375.05 },
  { name: 'app.schedule_batch', amount: 0 },
  { name: 'Sandboxes', amount: 3340.06 },
]

