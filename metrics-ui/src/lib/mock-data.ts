// Fake data for the Strada dashboard mockup.
// Row shapes mirror cli/src/tui-queries.ts (IssueRow, TraceSummaryRow, LogRow,
// Analytics*Row) and the otel_health_checks datasource, so pages can later swap
// these constants for real query results without changing the UI.

export const NOW = new Date('2026-09-23T14:00:00.000Z')

export type TimePoint = {
  time: Date
  [key: string]: Date | number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function noise(index: number, seed: number) {
  const value = Math.sin(index * 12.9898 + seed * 78.233) * 43758.5453
  return value - Math.floor(value)
}

// Daily traffic shape: low at night, peak in the afternoon (UTC).
function diurnal(time: Date) {
  const hour = time.getUTCHours() + time.getUTCMinutes() / 60
  return 0.55 + 0.45 * Math.sin(((hour - 8) / 24) * Math.PI * 2)
}

// 96 buckets of 15 minutes covering the last 24 hours.
export const quarterHours = Array.from({ length: 96 }, (_, index) => new Date(NOW.getTime() - (95 - index) * 15 * MINUTE))

// 30 daily buckets.
export const lastDays = Array.from({ length: 30 }, (_, index) => new Date(NOW.getTime() - (29 - index) * DAY))

function ago(ms: number) {
  return new Date(NOW.getTime() - ms).toISOString()
}

// ── Projects ─────────────────────────────────────────────────────

export type Project = { id: string; slug: string; services: string[] }

export const PROJECTS: Project[] = [
  { id: '01KPVGTT9CJW4ZNEF414VHGRFD', slug: 'api', services: ['api', 'worker', 'cron'] },
  { id: '01KPVH2M7XPQR8KNCZ0W4D9QEA', slug: 'frontend', services: ['web', 'docs'] },
  { id: '01KPVH8B3E1YF6T2R9ZC5KMN0S', slug: 'example-app', services: ['example-app'] },
]

// ── Issues (otel_errors + otel_issue_state) ──────────────────────

export type IssueStatus = 'open' | 'muted' | 'resolved'

export type Issue = {
  fingerprintHash: string
  shortId: string
  lastType: string
  lastMessage: string
  lastLevel: 'error' | 'fatal' | 'warning'
  culprit: string
  status: IssueStatus
  eventCount: number
  unhandledCount: number
  userCount: number
  firstSeen: string
  lastSeen: string
  lastServiceName: string
  lastHttpMethod: string
  lastHttpRoute: string
  lastEnvironment: string
  release: string
  assignee?: string
  isNew?: boolean
  isRegression?: boolean
  // 24 hourly buckets for the row sparkline
  frequency: number[]
}

function hourlyFrequency(seed: number, scale: number) {
  return Array.from({ length: 24 }, (_, index) => {
    const burst = noise(index, seed) > 0.82 ? 3 : 1
    return Math.round(noise(index, seed + 1) * scale * burst)
  })
}

export const ISSUES: Issue[] = [
  {
    fingerprintHash: 'a3f91c07e24b8d5610f7c2e98ab43d12',
    shortId: 'API-1K9',
    lastType: 'TypeError',
    lastMessage: "Cannot read properties of undefined (reading 'priceId')",
    lastLevel: 'error',
    culprit: 'src/billing/checkout.ts in createCheckoutSession',
    status: 'open',
    eventCount: 1284,
    unhandledCount: 1284,
    userCount: 312,
    firstSeen: ago(3 * HOUR),
    lastSeen: ago(2 * MINUTE),
    lastServiceName: 'api',
    lastHttpMethod: 'POST',
    lastHttpRoute: '/api/checkout',
    lastEnvironment: 'production',
    release: 'api@2.14.0',
    isNew: true,
    frequency: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 180, 460, 644],
  },
  {
    fingerprintHash: '5c0e8b2f9a714d63b1e0a7c4f2d98e31',
    shortId: 'API-1K2',
    lastType: 'DatabaseError',
    lastMessage: 'Connection terminated due to connection timeout',
    lastLevel: 'error',
    culprit: 'src/db/pool.ts in acquire',
    status: 'open',
    eventCount: 842,
    unhandledCount: 12,
    userCount: 97,
    firstSeen: ago(9 * DAY),
    lastSeen: ago(6 * MINUTE),
    lastServiceName: 'worker',
    lastHttpMethod: '',
    lastHttpRoute: '',
    lastEnvironment: 'production',
    release: 'api@2.14.0',
    assignee: 'marcus',
    frequency: hourlyFrequency(3, 60),
  },
  {
    fingerprintHash: 'e71d0a4c3b9f2e8657a1d0c9b8e4f213',
    shortId: 'WEB-8F1',
    lastType: 'ChunkLoadError',
    lastMessage: 'Loading chunk 412 failed (missing: /assets/pricing-Cq81.js)',
    lastLevel: 'error',
    culprit: 'webpack/runtime/jsonp chunk loading',
    status: 'open',
    eventCount: 403,
    unhandledCount: 403,
    userCount: 288,
    firstSeen: ago(26 * HOUR),
    lastSeen: ago(14 * MINUTE),
    lastServiceName: 'web',
    lastHttpMethod: 'GET',
    lastHttpRoute: '/pricing',
    lastEnvironment: 'production',
    release: 'web@5.2.1',
    isRegression: true,
    frequency: hourlyFrequency(5, 24),
  },
  {
    fingerprintHash: '0b4f7e2a91c8d35e6f0a2b7c9d1e4f58',
    shortId: 'API-1JX',
    lastType: 'StripeRateLimitError',
    lastMessage: 'Too many requests hit the API too quickly',
    lastLevel: 'warning',
    culprit: 'src/billing/stripe.ts in syncSubscription',
    status: 'open',
    eventCount: 219,
    unhandledCount: 0,
    userCount: 41,
    firstSeen: ago(4 * DAY),
    lastSeen: ago(38 * MINUTE),
    lastServiceName: 'worker',
    lastHttpMethod: '',
    lastHttpRoute: '',
    lastEnvironment: 'production',
    release: 'api@2.13.4',
    assignee: 'sabrina',
    frequency: hourlyFrequency(7, 14),
  },
  {
    fingerprintHash: 'c29a4e81f0b7d3265e9a1c0f4b8d7e62',
    shortId: 'WEB-8E7',
    lastType: 'ResizeObserver',
    lastMessage: 'ResizeObserver loop completed with undelivered notifications',
    lastLevel: 'warning',
    culprit: 'src/components/chart.tsx in useElementSize',
    status: 'muted',
    eventCount: 9120,
    unhandledCount: 9120,
    userCount: 2140,
    firstSeen: ago(41 * DAY),
    lastSeen: ago(1 * MINUTE),
    lastServiceName: 'web',
    lastHttpMethod: 'GET',
    lastHttpRoute: '/dash',
    lastEnvironment: 'production',
    release: 'web@5.2.1',
    frequency: hourlyFrequency(9, 400),
  },
  {
    fingerprintHash: '9d3b1f07a2e84c65b0d9e7a1c3f25b84',
    shortId: 'API-1JQ',
    lastType: 'ZodError',
    lastMessage: 'Invalid input: expected string, received undefined at "email"',
    lastLevel: 'error',
    culprit: 'src/routes/signup.ts in POST /api/signup',
    status: 'open',
    eventCount: 76,
    unhandledCount: 0,
    userCount: 58,
    firstSeen: ago(2 * DAY),
    lastSeen: ago(52 * MINUTE),
    lastServiceName: 'api',
    lastHttpMethod: 'POST',
    lastHttpRoute: '/api/signup',
    lastEnvironment: 'production',
    release: 'api@2.14.0',
    frequency: hourlyFrequency(11, 6),
  },
  {
    fingerprintHash: '4e8c2b9f1a07d3e56c4b8a2f0e9d1c73',
    shortId: 'CRON-3A',
    lastType: 'AbortError',
    lastMessage: 'The operation was aborted due to timeout after 30000ms',
    lastLevel: 'fatal',
    culprit: 'src/jobs/send-digest.ts in run',
    status: 'open',
    eventCount: 24,
    unhandledCount: 24,
    userCount: 0,
    firstSeen: ago(6 * HOUR),
    lastSeen: ago(1 * HOUR),
    lastServiceName: 'cron',
    lastHttpMethod: '',
    lastHttpRoute: '',
    lastEnvironment: 'production',
    release: 'api@2.14.0',
    isNew: true,
    frequency: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 4, 4, 4, 4],
  },
  {
    fingerprintHash: 'f10b8e3d7c2a4965e1f0b3a8d7c24e95',
    shortId: 'WEB-8D2',
    lastType: 'SecurityError',
    lastMessage: "Failed to read the 'localStorage' property from 'Window'",
    lastLevel: 'error',
    culprit: 'src/lib/session.ts in getSessionId',
    status: 'muted',
    eventCount: 188,
    unhandledCount: 188,
    userCount: 150,
    firstSeen: ago(18 * DAY),
    lastSeen: ago(3 * HOUR),
    lastServiceName: 'web',
    lastHttpMethod: 'GET',
    lastHttpRoute: '/embed',
    lastEnvironment: 'production',
    release: 'web@5.1.0',
    frequency: hourlyFrequency(13, 12),
  },
  {
    fingerprintHash: '2a7d9c0e4b1f8356a2d7c9e0b4f16a07',
    shortId: 'API-1H8',
    lastType: 'TinybirdQueryError',
    lastMessage: 'Unknown identifier: FingerprintHash in scope SELECT ...',
    lastLevel: 'error',
    culprit: 'src/query-backend.ts in runQuery',
    status: 'resolved',
    eventCount: 512,
    unhandledCount: 0,
    userCount: 22,
    firstSeen: ago(12 * DAY),
    lastSeen: ago(20 * HOUR),
    lastServiceName: 'api',
    lastHttpMethod: 'POST',
    lastHttpRoute: '/api/v0/query',
    lastEnvironment: 'production',
    release: 'api@2.13.2',
    assignee: 'lena',
    frequency: [30, 42, 51, 38, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    fingerprintHash: '8b0e3f6a2d9c1475b8e0f3a6d2c91b84',
    shortId: 'WEB-8C4',
    lastType: 'Error',
    lastMessage: 'Hydration failed because the server rendered HTML did not match',
    lastLevel: 'error',
    culprit: 'src/app/layout.tsx in RootLayout',
    status: 'resolved',
    eventCount: 97,
    unhandledCount: 97,
    userCount: 80,
    firstSeen: ago(7 * DAY),
    lastSeen: ago(2 * DAY),
    lastServiceName: 'web',
    lastHttpMethod: 'GET',
    lastHttpRoute: '/',
    lastEnvironment: 'production',
    release: 'web@5.2.0',
    assignee: 'sabrina',
    frequency: Array.from({ length: 24 }, () => 0),
  },
]

export const ISSUE_STACKTRACE = `TypeError: Cannot read properties of undefined (reading 'priceId')
    at createCheckoutSession (/app/src/billing/checkout.ts:88:31)
    at handler (/app/src/routes/checkout.ts:24:12)
    at Spiceflow.handle (/app/node_modules/spiceflow/dist/spiceflow.js:612:18)
    at async Spiceflow.fetch (/app/node_modules/spiceflow/dist/spiceflow.js:401:22)
    at async processTicksAndRejections (node:internal/process/task_queues:95:5)`

export const ISSUE_TAGS: { key: string; values: { name: string; share: number }[] }[] = [
  { key: 'url.path', values: [{ name: '/api/checkout', share: 0.92 }, { name: '/api/checkout/upgrade', share: 0.08 }] },
  { key: 'release', values: [{ name: 'api@2.14.0', share: 1 }] },
  { key: 'browser', values: [{ name: 'Chrome', share: 0.61 }, { name: 'Safari', share: 0.27 }, { name: 'Firefox', share: 0.12 }] },
  { key: 'user.plan', values: [{ name: 'pro', share: 0.74 }, { name: 'team', share: 0.26 }] },
]

export const ISSUE_EVENTS = Array.from({ length: 8 }, (_, index) => ({
  timestamp: ago((2 + index * 7) * MINUTE),
  httpMethod: 'POST',
  httpRoute: '/api/checkout',
  serviceName: 'api',
  userId: ['user_8f2k1', 'user_19azq', 'user_p0x3m', 'user_kk21a'][index % 4]!,
  traceId: `4bf92f3577b34da6a3ce929d0e0e${(4736 + index * 13).toString(16)}`,
  browser: index % 3 === 0 ? 'Safari 18' : 'Chrome 129',
}))

export const issueEvents: TimePoint[] = quarterHours.map((time, index) => {
  const load = diurnal(time)
  const spike = index > 84 ? 40 + noise(index, 2) * 30 : 0
  return {
    time,
    unhandled: Math.round(load * 18 + noise(index, 1) * 10 + spike),
    handled: Math.round(load * 9 + noise(index, 3) * 6),
  }
})

// ── Traces (otel_traces) ─────────────────────────────────────────

export const traceThroughput: TimePoint[] = quarterHours.map((time, index) => {
  const requests = Math.round(diurnal(time) * 5200 + noise(index, 4) * 700)
  const errorRatio = index > 84 ? 0.024 : 0.004 + noise(index, 5) * 0.004
  return { time, ok: requests - Math.round(requests * errorRatio), error: Math.round(requests * errorRatio) }
})

export const traceLatency: TimePoint[] = quarterHours.map((time, index) => {
  const load = diurnal(time)
  const p50 = 38 + load * 14 + noise(index, 6) * 6
  const p95 = p50 * 3.4 + noise(index, 7) * 40 + (index > 84 ? 160 : 0)
  return { time, p50, p95, p99: p95 * 1.9 + noise(index, 8) * 90 }
})

export type Endpoint = {
  serviceName: string
  spanName: string
  spanKind: 'server' | 'client' | 'internal' | 'consumer'
  count: number
  errorRate: number
  p50: number
  p95: number
  p99: number
  spark: number[]
}

function endpointSpark(seed: number) {
  return Array.from({ length: 24 }, (_, index) => 40 + noise(index, seed) * 60)
}

export const ENDPOINTS: Endpoint[] = [
  { serviceName: 'api', spanName: 'POST /api/checkout', spanKind: 'server', count: 18420, errorRate: 0.071, p50: 184, p95: 920, p99: 2410, spark: endpointSpark(1) },
  { serviceName: 'api', spanName: 'GET /api/v0/projects/:projectId/issues', spanKind: 'server', count: 96210, errorRate: 0.002, p50: 62, p95: 240, p99: 610, spark: endpointSpark(2) },
  { serviceName: 'api', spanName: 'POST /api/v0/query', spanKind: 'server', count: 44180, errorRate: 0.011, p50: 210, p95: 1340, p99: 3820, spark: endpointSpark(3) },
  { serviceName: 'api', spanName: 'tinybird /v0/sql', spanKind: 'client', count: 51022, errorRate: 0.009, p50: 170, p95: 1120, p99: 3100, spark: endpointSpark(4) },
  { serviceName: 'worker', spanName: 'queue send-digest', spanKind: 'consumer', count: 3210, errorRate: 0.007, p50: 1820, p95: 6400, p99: 14200, spark: endpointSpark(5) },
  { serviceName: 'api', spanName: 'd1 SELECT project', spanKind: 'client', count: 182330, errorRate: 0, p50: 4, p95: 18, p99: 44, spark: endpointSpark(6) },
  { serviceName: 'api', spanName: 'stripe POST /v1/checkout/sessions', spanKind: 'client', count: 17110, errorRate: 0.004, p50: 390, p95: 880, p99: 1900, spark: endpointSpark(7) },
  { serviceName: 'worker', spanName: 'stripe GET /v1/subscriptions', spanKind: 'client', count: 8840, errorRate: 0.025, p50: 240, p95: 610, p99: 1450, spark: endpointSpark(8) },
  { serviceName: 'api', spanName: 'GET /api/v0/health', spanKind: 'server', count: 288000, errorRate: 0, p50: 2, p95: 6, p99: 11, spark: endpointSpark(9) },
  { serviceName: 'cron', spanName: 'cron alert-check', spanKind: 'internal', count: 288, errorRate: 0.035, p50: 4200, p95: 11800, p99: 29000, spark: endpointSpark(10) },
]

export const latencyHistogram = [
  ['<10ms', 182000],
  ['10-25', 96000],
  ['25-50', 71000],
  ['50-100', 58000],
  ['100-250', 39000],
  ['250-500', 17000],
  ['0.5-1s', 7400],
  ['1-2.5s', 2600],
  ['2.5-5s', 640],
  ['>5s', 190],
].map(([x, value]) => ({ x: String(x), series: 'Requests', value: Number(value) }))

export type TraceSummary = {
  traceId: string
  startTime: string
  durationMs: number
  spanCount: number
  errorSpanCount: number
  services: string[]
  rootSpanName: string
  rootServiceName: string
}

const TRACE_ROOTS: [string, string, string[]][] = [
  ['POST /api/v0/query', 'api', ['api', 'tinybird']],
  ['queue send-digest', 'worker', ['worker', 'api']],
  ['POST /api/checkout', 'api', ['api', 'stripe']],
  ['cron alert-check', 'cron', ['cron', 'api']],
  ['GET /dash/projects/:projectId', 'web', ['web', 'api']],
]

export const SLOW_TRACES: TraceSummary[] = Array.from({ length: 12 }, (_, index) => {
  const [rootSpanName, rootServiceName, services] = TRACE_ROOTS[index % TRACE_ROOTS.length]!
  return {
    traceId: `${(0x4bf92f35 + index * 7919).toString(16)}77b34da6a3ce929d0e0e${(4736 + index).toString(16)}`,
    startTime: ago((3 + index * 11) * MINUTE),
    durationMs: Math.round(14800 / (1 + index * 0.35)),
    spanCount: 12 + Math.round(noise(index, 9) * 140),
    errorSpanCount: index % 4 === 2 ? 1 + (index % 3) : 0,
    services,
    rootSpanName,
    rootServiceName,
  }
})

// ── Logs (otel_logs) ─────────────────────────────────────────────

export const logVolume: TimePoint[] = quarterHours.map((time, index) => {
  const load = diurnal(time)
  return {
    time,
    info: Math.round(load * 3400 + noise(index, 10) * 500),
    warn: Math.round(load * 260 + noise(index, 11) * 80),
    error: Math.round(load * 60 + noise(index, 12) * 40 + (index > 84 ? 180 : 0)),
  }
})

export type Severity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL'

export type LogRow = {
  id: string
  timestamp: string
  severityText: Severity
  serviceName: string
  body: string
  traceId: string
  attributes: Record<string, string>
}

const LOG_TEMPLATES: [Severity, string, string, Record<string, string>][] = [
  ['INFO', 'api', 'POST /api/checkout 500 in 212ms', { 'http.route': '/api/checkout', 'http.response.status_code': '500' }],
  ['ERROR', 'api', "TypeError: Cannot read properties of undefined (reading 'priceId')", { 'exception.type': 'TypeError', 'url.path': '/api/checkout' }],
  ['INFO', 'api', 'GET /api/v0/projects/01KPVGTT/issues 200 in 58ms', { 'http.route': '/api/v0/projects/:projectId/issues' }],
  ['WARN', 'worker', 'stripe rate limited, retrying in 2000ms (attempt 2/5)', { 'retry.attempt': '2', 'stripe.request_id': 'req_9f2Kq1' }],
  ['INFO', 'worker', 'digest queued for 184 recipients', { 'queue.name': 'send-digest', 'digest.recipients': '184' }],
  ['DEBUG', 'api', 'cache miss project:01KPVGTT9CJW4ZNEF414VHGRFD, loading from d1', { 'cache.key': 'project:01KPVGTT' }],
  ['INFO', 'web', 'pageview /pricing', { 'event.name': 'pageview', 'session.id': '3f0c9e1a' }],
  ['INFO', 'web', 'signup_started', { 'event.name': 'signup_started', 'custom.plan': 'pro' }],
  ['ERROR', 'worker', 'Connection terminated due to connection timeout', { 'db.system': 'postgresql', 'pool.waiting': '14' }],
  ['INFO', 'cron', 'alert-check evaluated 42 rules in 3.8s', { 'alert.rules': '42' }],
  ['WARN', 'api', 'slow query 1340ms: SELECT FingerprintHash, count() FROM otel_errors', { 'db.system': 'clickhouse', 'db.duration_ms': '1340' }],
  ['FATAL', 'cron', 'send-digest aborted after 30000ms timeout', { 'exception.type': 'AbortError' }],
]

export const LOGS: LogRow[] = Array.from({ length: 36 }, (_, index) => {
  const [severityText, serviceName, body, attributes] = LOG_TEMPLATES[(index * 5) % LOG_TEMPLATES.length]!
  return {
    id: `log-${index}`,
    timestamp: ago(index * 17_000 + Math.round(noise(index, 13) * 9_000)),
    severityText,
    serviceName,
    body,
    traceId: index % 3 === 0 ? '' : `4bf92f3577b34da6a3ce929d0e0e${(4736 + index * 3).toString(16)}`,
    attributes,
  }
})

// ── Health checks (otel_health_checks + alert_rule) ──────────────

export type CheckStatus = 'up' | 'degraded' | 'down'

export type HealthCheck = {
  checkId: string
  name: string
  url: string
  method: string
  schedule: string
  status: CheckStatus
  lastStatusCode: number
  lastCheckedAt: string
  errorMessage: string
  p50Ms: number
  p95Ms: number
  // 90 daily uptime ratios, oldest first
  uptimeDays: number[]
}

function uptimeDays(seed: number, incidents: number[]) {
  return Array.from({ length: 90 }, (_, index) => {
    if (incidents.includes(index)) return 0.9 + noise(index, seed) * 0.07
    return noise(index, seed) > 0.97 ? 0.995 : 1
  })
}

export const HEALTH_CHECKS: HealthCheck[] = [
  { checkId: 'chk_checkout', name: 'Checkout API', url: 'https://api.strada.sh/api/checkout/health', method: 'GET', schedule: '*/5 * * * *', status: 'down', lastStatusCode: 503, lastCheckedAt: ago(2 * MINUTE), errorMessage: 'Expected 200-299, got 503 Service Unavailable', p50Ms: 212, p95Ms: 980, uptimeDays: [...uptimeDays(1, [61]).slice(0, 89), 0.93] },
  { checkId: 'chk_ingest', name: 'Ingest endpoint', url: 'https://01KPVGTT9CJW4ZNEF414VHGRFD-ingest.strada.sh/health', method: 'GET', schedule: '*/5 * * * *', status: 'up', lastStatusCode: 200, lastCheckedAt: ago(1 * MINUTE), errorMessage: '', p50Ms: 38, p95Ms: 91, uptimeDays: uptimeDays(2, [22]) },
  { checkId: 'chk_web', name: 'Website', url: 'https://strada.sh', method: 'GET', schedule: '*/5 * * * *', status: 'up', lastStatusCode: 200, lastCheckedAt: ago(3 * MINUTE), errorMessage: '', p50Ms: 120, p95Ms: 260, uptimeDays: uptimeDays(3, []) },
  { checkId: 'chk_docs', name: 'Docs', url: 'https://strada.sh/docs', method: 'GET', schedule: '*/15 * * * *', status: 'up', lastStatusCode: 200, lastCheckedAt: ago(9 * MINUTE), errorMessage: '', p50Ms: 96, p95Ms: 210, uptimeDays: uptimeDays(4, []) },
  { checkId: 'chk_query', name: 'Query API', url: 'https://strada.sh/api/v0/health', method: 'GET', schedule: '*/5 * * * *', status: 'degraded', lastStatusCode: 200, lastCheckedAt: ago(4 * MINUTE), errorMessage: 'p95 latency above 1s for 3 checks', p50Ms: 640, p95Ms: 1420, uptimeDays: uptimeDays(5, [74, 88]) },
  { checkId: 'chk_webhook', name: 'Stripe webhook', url: 'https://strada.sh/api/stripe/webhook', method: 'HEAD', schedule: '0 * * * *', status: 'up', lastStatusCode: 204, lastCheckedAt: ago(41 * MINUTE), errorMessage: '', p50Ms: 54, p95Ms: 130, uptimeDays: uptimeDays(6, [40]) },
]

export const checkRuns: TimePoint[] = quarterHours.map((time, index) => {
  const failed = index > 86 ? 3 : noise(index, 14) > 0.93 ? 1 : 0
  return { time, success: 18 - failed, failed }
})

export const checkLatency: TimePoint[] = quarterHours.map((time, index) => ({
  time,
  p50: 90 + noise(index, 15) * 30 + (index > 86 ? 120 : 0),
  p95: 260 + noise(index, 16) * 120 + (index > 86 ? 700 : 0),
}))

// ── Analytics (otel_analytics_pages / otel_analytics_sessions) ───

export const ANALYTICS_KPIS = [
  { label: 'Visitors', value: '48.2k', delta: 0.124 },
  { label: 'Pageviews', value: '171k', delta: 0.087 },
  { label: 'Bounce rate', value: '41.3%', delta: -0.032 },
  { label: 'Visit duration', value: '2m 48s', delta: 0.051 },
]

export const visitorsDaily: TimePoint[] = lastDays.map((time, index) => {
  const weekday = time.getUTCDay()
  const weekend = weekday === 0 || weekday === 6 ? 0.62 : 1
  const growth = 1 + index * 0.012
  const launch = index === 21 ? 2.4 : index === 22 ? 1.5 : 1
  const visitors = Math.round(1350 * weekend * growth * launch + noise(index, 17) * 180)
  return { time, visitors, pageviews: Math.round(visitors * (3.3 + noise(index, 18) * 0.6)) }
})

export type RankRow = { name: string; value: number; icon?: string; secondary?: number }

export const TOP_PAGES: RankRow[] = [
  { name: '/', value: 18420 },
  { name: '/pricing', value: 9310 },
  { name: '/docs', value: 7820 },
  { name: '/docs/sdk/browser', value: 4410 },
  { name: '/blog/opentelemetry-without-sentry', value: 3960 },
  { name: '/dash', value: 2870 },
  { name: '/docs/cli/issues-list', value: 1540 },
  { name: '/changelog', value: 1120 },
]

export const REFERRERS: RankRow[] = [
  { name: 'Direct / None', value: 16200 },
  { name: 'news.ycombinator.com', value: 11480, icon: 'Y' },
  { name: 'google.com', value: 8210, icon: 'G' },
  { name: 'x.com', value: 4120, icon: '𝕏' },
  { name: 'github.com', value: 3310, icon: 'GH' },
  { name: 'reddit.com', value: 1290, icon: 'R' },
  { name: 'duckduckgo.com', value: 610, icon: 'D' },
]

export const COUNTRIES: RankRow[] = [
  { name: 'United States', value: 17400, icon: '🇺🇸' },
  { name: 'Germany', value: 5210, icon: '🇩🇪' },
  { name: 'United Kingdom', value: 4380, icon: '🇬🇧' },
  { name: 'India', value: 3920, icon: '🇮🇳' },
  { name: 'Italy', value: 2140, icon: '🇮🇹' },
  { name: 'France', value: 1980, icon: '🇫🇷' },
  { name: 'Canada', value: 1760, icon: '🇨🇦' },
  { name: 'Japan', value: 1120, icon: '🇯🇵' },
]

export const BROWSERS: RankRow[] = [
  { name: 'Chrome', value: 29100 },
  { name: 'Safari', value: 10400 },
  { name: 'Firefox', value: 4620 },
  { name: 'Edge', value: 2510 },
  { name: 'Arc', value: 1180 },
  { name: 'Brave', value: 390 },
]

export const DEVICES: RankRow[] = [
  { name: 'Desktop', value: 34800 },
  { name: 'Mobile', value: 12100 },
  { name: 'Tablet', value: 1300 },
]

export const CUSTOM_EVENTS: RankRow[] = [
  { name: 'signup_started', value: 2410, secondary: 2190 },
  { name: 'docs_copy_code', value: 1880, secondary: 1204 },
  { name: 'signup_completed', value: 1320, secondary: 1318 },
  { name: 'project_created', value: 910, secondary: 874 },
  { name: 'checkout_started', value: 402, secondary: 390 },
  { name: 'purchase', value: 188, secondary: 188 },
]

// ── Usage (settings) ─────────────────────────────────────────────

export const ingestDaily: TimePoint[] = lastDays.map((time, index) => {
  const load = 1 + index * 0.01
  return {
    time,
    spans: Math.round((4.1 + noise(index, 19) * 0.8) * load * 1_000_000),
    logs: Math.round((2.2 + noise(index, 20) * 0.5) * load * 1_000_000),
    errors: Math.round((0.04 + noise(index, 21) * 0.03) * 1_000_000),
  }
})
