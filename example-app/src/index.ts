// Example Spiceflow app that emits traces, logs, metrics, and errors to Strada.

import dns from 'node:dns'
import { Spiceflow } from 'spiceflow'
import {
  captureException,
  flush,
  initStrada,
  logs,
  metrics,
  SeverityNumber,
  shutdown,
  SpanStatusCode,
  trace,
} from '@strada.sh/sdk'

const projectId = process.env.STRADA_PROJECT_ID
if (!projectId) {
  throw new Error('Missing STRADA_PROJECT_ID for example-app.')
}

const endpoint = process.env.STRADA_ENDPOINT || `https://${projectId}-ingest.strada.sh`
const ingestIp = process.env.STRADA_INGEST_IP

if (ingestIp) {
  const endpointHost = new URL(endpoint).hostname
  const originalLookup = dns.lookup
  dns.lookup = function patchedLookup(hostname: string, options: any, callback?: any) {
    if (hostname !== endpointHost) {
      return callback == null
        ? originalLookup(hostname as any, options as any)
        : originalLookup(hostname as any, options as any, callback as any)
    }

    const resolvedOptions = typeof options === 'function' || options == null ? {} : options
    const resolvedCallback = typeof options === 'function' ? options : callback

    if (!resolvedCallback) {
      return originalLookup(hostname as any, options as any)
    }

    if (resolvedOptions.all) {
      resolvedCallback(null, [{ address: ingestIp, family: 4 }])
      return
    }

    resolvedCallback(null, ingestIp, 4)
  } as typeof dns.lookup
}

initStrada({
  projectId,
  endpoint,
  service: 'example-app',
  environment: process.env.NODE_ENV || 'development',
  telemetry: {
    metrics: {
      exportIntervalMillis: 500,
      exportTimeoutMillis: 5_000,
    },
  },
})

const tracer = trace.getTracer('example-app')
const logger = logs.getLogger('example-app')
const meter = metrics.getMeter('example-app')
const requestCounter = meter.createCounter('example.requests')
const durationHistogram = meter.createHistogram('example.duration.ms')
const queueDepthGauge = meter.createObservableGauge('example.queue.depth')

queueDepthGauge.addCallback((observer) => {
  observer.observe(3, { queue: 'jobs' })
})

const app = new Spiceflow({ tracer })
  .get('/', () => {
    return {
      ok: true,
      service: 'example-app',
      hint: 'GET /demo to emit telemetry',
    }
  })
  .get('/demo', async ({ span }) => {
    const startedAt = Date.now()
    span.setAttribute('example.kind', 'demo')
    span.setAttribute('example.route', '/demo')

    try {
      requestCounter.add(1, { route: '/demo' })
      logger.emit({
        severityNumber: SeverityNumber.INFO,
        severityText: 'INFO',
        body: 'example demo request',
        attributes: {
          'event.name': 'example_demo_request',
          'custom.route': '/demo',
        },
      })

      try {
        throw new Error('example demo failure')
      } catch (error) {
        captureException(error, {
          handled: true,
          mechanism: 'generic',
          tags: { route: '/demo' },
        })
        if (error instanceof Error) {
          span.recordException(error)
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'example demo failure' })
      }

      return {
        ok: true,
        emitted: ['trace', 'log', 'metric', 'error'],
      }
    } finally {
      durationHistogram.record(Date.now() - startedAt, { route: '/demo' })
      await flush()
    }
  })

const port = Number(process.env.PORT || 5446)
app.listen(port)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    shutdown().finally(() => process.exit(0))
  })
}

console.log(`example-app listening on http://127.0.0.1:${port}`)
