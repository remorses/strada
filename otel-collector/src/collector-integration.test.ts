import { once } from 'node:events'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { SpanStatusCode } from '@opentelemetry/api'
import { SeverityNumber } from '@opentelemetry/api-logs'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'

interface CapturedInsert {
  query: string
  table: string
  rows: Record<string, unknown>[]
}

interface StartedServer {
  server: Server
  host: string
  port: number
  baseUrl: string
}

function parsePortFromEnv(name: string): number {
  const raw = process.env[name]
  if (!raw) return 0

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid port in ${name}: ${raw}`)
  }

  return parsed
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of req) {
    chunks.push(
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
    )
  }
  return chunks.join('')
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function startServer(
  requestedPort: number,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<StartedServer> {
  const host = '127.0.0.1'
  const server = createServer(handler)
  server.listen(requestedPort, host)
  await once(server, 'listening')

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve server address')
  }

  return {
    server,
    host,
    port: address.port,
    baseUrl: `http://${host}:${address.port}`,
  }
}

function extractTable(query: string): string {
  const match = /INSERT INTO\s+[^.]+\.([A-Za-z0-9_]+)\s+FORMAT JSONEachLine/.exec(
    query,
  )
  return match?.[1] ?? 'unknown'
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function emitOtelData(baseUrl: string): Promise<void> {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'collector-integration-test',
  })

  const traceExporter = new OTLPTraceExporter({
    url: `${baseUrl}/v1/traces`,
  })
  const traceProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(traceExporter, {
        scheduledDelayMillis: 20,
        maxQueueSize: 64,
        maxExportBatchSize: 64,
      }),
    ],
  })

  const tracer = traceProvider.getTracer('collector-integration-test')
  const span = tracer.startSpan('checkout')
  span.setAttribute('http.method', 'POST')
  span.setAttribute('http.route', '/checkout')
  span.recordException(new Error('payment declined'))
  span.setStatus({ code: SpanStatusCode.ERROR, message: 'checkout failed' })
  span.end()

  await traceProvider.forceFlush()

  const logExporter = new OTLPLogExporter({
    url: `${baseUrl}/v1/logs`,
  })
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor(logExporter, {
        scheduledDelayMillis: 20,
        maxQueueSize: 64,
        maxExportBatchSize: 64,
      }),
    ],
  })

  const logger = loggerProvider.getLogger('collector-integration-test')
  logger.emit({
    eventName: 'checkout.log',
    severityNumber: SeverityNumber.ERROR,
    severityText: 'ERROR',
    body: 'checkout failed',
    attributes: {
      'exception.type': 'CheckoutError',
      'exception.message': 'payment declined',
      order_id: 'order-123',
    },
  })

  await loggerProvider.forceFlush()

  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${baseUrl}/v1/metrics`,
    }),
    exportIntervalMillis: 3_600_000,
  })

  const meterProvider = new MeterProvider({
    resource,
    readers: [metricReader],
  })
  const meter = meterProvider.getMeter('collector-integration-test')

  const counter = meter.createCounter('checkout.attempts')
  counter.add(1, { route: '/checkout' })

  const histogram = meter.createHistogram('checkout.duration.ms')
  histogram.record(245.5, { route: '/checkout' })

  const gauge = meter.createObservableGauge('queue.depth')
  gauge.addCallback((result) => {
    result.observe(7, { queue: 'payments' })
  })

  await Promise.all([
    traceProvider.shutdown(),
    loggerProvider.shutdown(),
    meterProvider.shutdown(),
  ])
}

function sortByJson<T>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  )
}

const VOLATILE_FIELDS = new Set([
  'TraceId',
  'SpanId',
  'ParentSpanId',
  'Duration',
  'Timestamp',
  'StartTimeUnix',
  'TimeUnix',
  'EventsTimestamp',
  'ExemplarsTimestamp',
  'ExemplarsTraceId',
  'ExemplarsSpanId',
  'FingerprintHash',
])

function stripVolatileFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripVolatileFields)
  }

  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([key]) => !VOLATILE_FIELDS.has(key))
      .map(([key, entryValue]) => [key, stripVolatileFields(entryValue)] as const)
      .sort(([a], [b]) => a.localeCompare(b))
    return Object.fromEntries(entries)
  }

  if (typeof value === 'string') {
    return value
      .replace(
        /file:\/\/\/[^\s"]+node_modules\/\.pnpm\/@vitest\+runner@[^/]+\/node_modules\/@vitest\/runner\/dist\/chunk-[^":]+\.js(?::\d+:\d+)?/g,
        'file:///__vitest_runner__/dist/chunk-vitest.js:0:0',
      )
      .replace(
        /(collector-integration\.test\.ts):(\d+):(\d+)/g,
        '$1:0:0',
      )
      .replace(
        /(collector-integration\.test\.ts","lineno":)(\d+)(,"colno":)(\d+)/g,
        '$1 0$3 0',
      )
  }

  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

describe.sequential('collector integration with official OTel SDKs', () => {
  it('exports traces/logs/metrics to ClickHouse SQL with valid JSON payloads', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'collector-integration-'))
    const outputFile = join(tmpDir, 'captured-inserts.json')
    const inserts: CapturedInsert[] = []

    const fakeBackend = await startServer(
      parsePortFromEnv('OTEL_COLLECTOR_FAKE_BACKEND_PORT'),
      async (req, res) => {
        const body = await readBody(req)
        const base = `http://${req.headers.host ?? '127.0.0.1'}`
        const url = new URL(req.url ?? '/', base)
        const query = url.searchParams.get('query') ?? ''
        const rows = body
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>)

        inserts.push({
          query,
          table: extractTable(query),
          rows,
        })

        await writeFile(outputFile, JSON.stringify({ inserts }, null, 2), 'utf8')

        res.statusCode = 200
        res.end('OK')
      },
    )

    const originalEnv = {
      TINYBIRD_ENDPOINT: process.env.TINYBIRD_ENDPOINT,
      TINYBIRD_TOKEN: process.env.TINYBIRD_TOKEN,
      CLICKHOUSE_URL: process.env.CLICKHOUSE_URL,
      CLICKHOUSE_DATABASE: process.env.CLICKHOUSE_DATABASE,
      CLICKHOUSE_USER: process.env.CLICKHOUSE_USER,
      CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD,
    }

    let collector: StartedServer | undefined

    try {
      delete process.env.TINYBIRD_ENDPOINT
      delete process.env.TINYBIRD_TOKEN
      process.env.CLICKHOUSE_URL = fakeBackend.baseUrl
      process.env.CLICKHOUSE_DATABASE = 'default'
      process.env.CLICKHOUSE_USER = 'default'
      process.env.CLICKHOUSE_PASSWORD = ''

      const collectorModule = await import('./index.ts')

      const listener = await collectorModule.app.listen(
        parsePortFromEnv('OTEL_COLLECTOR_TEST_PORT'),
        '127.0.0.1',
      )

      collector = {
        server: listener.server,
        host: '127.0.0.1',
        port: listener.port,
        baseUrl: `http://127.0.0.1:${listener.port}`,
      }

      await emitOtelData(collector.baseUrl)

      await waitFor(() => {
        const tables = new Set(inserts.map((insert) => insert.table))
        return (
          tables.has('otel_traces') &&
          tables.has('otel_logs') &&
          tables.has('otel_errors') &&
          tables.has('otel_metrics_sum') &&
          tables.has('otel_metrics_histogram') &&
          tables.has('otel_metrics_gauge')
        )
      }, 8_000)

      const fileText = await readFile(outputFile, 'utf8')
      const parsed = JSON.parse(fileText) as { inserts: CapturedInsert[] }

      expect(Array.isArray(parsed.inserts)).toBe(true)

      const queries = [...new Set(parsed.inserts.map((insert) => insert.query))]
        .filter((query) => query.length > 0)
        .sort()

      expect(queries).toMatchInlineSnapshot(`
        [
          "INSERT INTO default.otel_errors FORMAT JSONEachLine",
          "INSERT INTO default.otel_logs FORMAT JSONEachLine",
          "INSERT INTO default.otel_metrics_gauge FORMAT JSONEachLine",
          "INSERT INTO default.otel_metrics_histogram FORMAT JSONEachLine",
          "INSERT INTO default.otel_metrics_sum FORMAT JSONEachLine",
          "INSERT INTO default.otel_traces FORMAT JSONEachLine",
        ]
      `)

      const rowsByTable = new Map<string, Record<string, unknown>[]>()
      for (const insert of parsed.inserts) {
        const existing = rowsByTable.get(insert.table) ?? []
        existing.push(...insert.rows)
        rowsByTable.set(insert.table, existing)
      }

      const normalizedRows = [...rowsByTable.entries()]
        .map(([table, rows]) => ({
          table,
          rows: sortByJson(rows.map((row) => stripVolatileFields(row))),
        }))
        .sort((a, b) => a.table.localeCompare(b.table))

      expect(normalizedRows).toMatchInlineSnapshot(`
        [
          {
            "rows": [
              {
                "DebugId": "",
                "Environment": "",
                "ExceptionFrames": "",
                "ExceptionMessage": "payment declined",
                "ExceptionStacktrace": "",
                "ExceptionType": "CheckoutError",
                "Fingerprint": [
                  "CheckoutError",
                  "payment declined",
                ],
                "Level": "error",
                "MechanismHandled": true,
                "MechanismType": "generic",
                "Release": "",
                "ResourceAttributes": {
                  "service.name": "collector-integration-test",
                },
                "ScopeAttributes": {},
                "ServiceName": "collector-integration-test",
                "SourceSignal": "log",
                "Tags": {
                  "order_id": "order-123",
                },
              },
              {
                "DebugId": "",
                "Environment": "",
                "ExceptionFrames": "[{"filename":"file:///__vitest_runner__/dist/chunk-vitest.js:0:0","lineno":1893,"colno":20,"in_app":false},{"function":"processTicksAndRejections","filename":"node:internal/process/task_queues","lineno":104,"colno":5,"in_app":false},{"filename":"/Users/morse/Documents/GitHub/strada/otel-collector/src/collector-integration.test.ts","lineno": 0,"colno": 0,"in_app":true},{"function":"emitOtelData","filename":"/Users/morse/Documents/GitHub/strada/otel-collector/src/collector-integration.test.ts","lineno": 0,"colno": 0,"in_app":true}]",
                "ExceptionMessage": "payment declined",
                "ExceptionStacktrace": "Error: payment declined
            at emitOtelData (/Users/morse/Documents/GitHub/strada/otel-collector/src/collector-integration.test.ts:0:0)
            at /Users/morse/Documents/GitHub/strada/otel-collector/src/collector-integration.test.ts:0:0
            at processTicksAndRejections (node:internal/process/task_queues:104:5)
            at file:///__vitest_runner__/dist/chunk-vitest.js:0:0",
                "ExceptionType": "Error",
                "Fingerprint": [
                  "Error",
                  "emitOtelData",
                ],
                "Level": "error",
                "MechanismHandled": true,
                "MechanismType": "generic",
                "Release": "",
                "ResourceAttributes": {
                  "service.name": "collector-integration-test",
                },
                "ScopeAttributes": {},
                "ServiceName": "collector-integration-test",
                "SourceSignal": "trace",
                "Tags": {},
              },
            ],
            "table": "otel_errors",
          },
          {
            "rows": [
              {
                "Body": "checkout failed",
                "EventName": "checkout.log",
                "LogAttributes": {
                  "exception.message": "payment declined",
                  "exception.type": "CheckoutError",
                  "order_id": "order-123",
                },
                "ResourceAttributes": {
                  "service.name": "collector-integration-test",
                },
                "ResourceSchemaUrl": "",
                "ScopeAttributes": {},
                "ScopeName": "collector-integration-test",
                "ScopeSchemaUrl": "",
                "ScopeVersion": "",
                "ServiceName": "collector-integration-test",
                "SeverityNumber": 17,
                "SeverityText": "ERROR",
                "TraceFlags": 0,
              },
            ],
            "table": "otel_logs",
          },
          {
            "rows": [
              {
                "Attributes": {
                  "queue": "payments",
                },
                "ExemplarsFilteredAttributes": [],
                "ExemplarsValue": [],
                "Flags": 0,
                "MetricDescription": "",
                "MetricName": "queue.depth",
                "MetricUnit": "",
                "ResourceAttributes": {
                  "service.name": "collector-integration-test",
                },
                "ResourceSchemaUrl": "",
                "ScopeAttributes": {},
                "ScopeDroppedAttrCount": 0,
                "ScopeName": "collector-integration-test",
                "ScopeSchemaUrl": "",
                "ScopeVersion": "",
                "ServiceName": "collector-integration-test",
                "Value": 7,
              },
            ],
            "table": "otel_metrics_gauge",
          },
          {
            "rows": [
              {
                "AggregationTemporality": 2,
                "Attributes": {
                  "route": "/checkout",
                },
                "BucketCounts": [
                  0,
                  0,
                  0,
                  0,
                  0,
                  0,
                  0,
                  1,
                  0,
                  0,
                  0,
                  0,
                  0,
                  0,
                  0,
                  0,
                ],
                "Count": 1,
                "ExemplarsFilteredAttributes": [],
                "ExemplarsValue": [],
                "ExplicitBounds": [
                  0,
                  5,
                  10,
                  25,
                  50,
                  75,
                  100,
                  250,
                  500,
                  750,
                  1000,
                  2500,
                  5000,
                  7500,
                  10000,
                ],
                "Flags": 0,
                "Max": 245.5,
                "MetricDescription": "",
                "MetricName": "checkout.duration.ms",
                "MetricUnit": "",
                "Min": 245.5,
                "ResourceAttributes": {
                  "service.name": "collector-integration-test",
                },
                "ResourceSchemaUrl": "",
                "ScopeAttributes": {},
                "ScopeDroppedAttrCount": 0,
                "ScopeName": "collector-integration-test",
                "ScopeSchemaUrl": "",
                "ScopeVersion": "",
                "ServiceName": "collector-integration-test",
                "Sum": 245.5,
              },
            ],
            "table": "otel_metrics_histogram",
          },
          {
            "rows": [
              {
                "AggregationTemporality": 2,
                "Attributes": {
                  "route": "/checkout",
                },
                "ExemplarsFilteredAttributes": [],
                "ExemplarsValue": [],
                "Flags": 0,
                "IsMonotonic": true,
                "MetricDescription": "",
                "MetricName": "checkout.attempts",
                "MetricUnit": "",
                "ResourceAttributes": {
                  "service.name": "collector-integration-test",
                },
                "ResourceSchemaUrl": "",
                "ScopeAttributes": {},
                "ScopeDroppedAttrCount": 0,
                "ScopeName": "collector-integration-test",
                "ScopeSchemaUrl": "",
                "ScopeVersion": "",
                "ServiceName": "collector-integration-test",
                "Value": 1,
              },
            ],
            "table": "otel_metrics_sum",
          },
          {
            "rows": [
              {
                "EventsAttributes": [
                  {
                    "exception.message": "payment declined",
                    "exception.stacktrace": "Error: payment declined
            at emitOtelData (/Users/morse/Documents/GitHub/strada/otel-collector/src/collector-integration.test.ts:0:0)
            at /Users/morse/Documents/GitHub/strada/otel-collector/src/collector-integration.test.ts:0:0
            at processTicksAndRejections (node:internal/process/task_queues:104:5)
            at file:///__vitest_runner__/dist/chunk-vitest.js:0:0",
                    "exception.type": "Error",
                  },
                ],
                "EventsName": [
                  "exception",
                ],
                "LinksAttributes": [],
                "LinksSpanId": [],
                "LinksTraceId": [],
                "LinksTraceState": [],
                "ResourceAttributes": {
                  "service.name": "collector-integration-test",
                },
                "ResourceSchemaUrl": "",
                "ScopeAttributes": {},
                "ScopeName": "collector-integration-test",
                "ScopeSchemaUrl": "",
                "ScopeVersion": "",
                "ServiceName": "collector-integration-test",
                "SpanAttributes": {
                  "http.method": "POST",
                  "http.route": "/checkout",
                },
                "SpanKind": "Internal",
                "SpanName": "checkout",
                "StatusCode": "Error",
                "StatusMessage": "checkout failed",
                "TraceFlags": 257,
                "TraceState": "",
              },
            ],
            "table": "otel_traces",
          },
        ]
      `)
    } finally {
      if (collector) {
        await closeServer(collector.server)
      }
      await closeServer(fakeBackend.server)

      process.env.TINYBIRD_ENDPOINT = originalEnv.TINYBIRD_ENDPOINT
      process.env.TINYBIRD_TOKEN = originalEnv.TINYBIRD_TOKEN
      process.env.CLICKHOUSE_URL = originalEnv.CLICKHOUSE_URL
      process.env.CLICKHOUSE_DATABASE = originalEnv.CLICKHOUSE_DATABASE
      process.env.CLICKHOUSE_USER = originalEnv.CLICKHOUSE_USER
      process.env.CLICKHOUSE_PASSWORD = originalEnv.CLICKHOUSE_PASSWORD
    }
  }, 20_000)
})
