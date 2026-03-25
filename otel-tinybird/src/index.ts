// OTLP-to-Tinybird proxy on Cloudflare Workers.
// Receives OTLP HTTP/JSON traces, logs, and metrics from any OTEL SDK
// and forwards them to the Tinybird Events API as NDJSON.

import { Spiceflow } from 'spiceflow'
import { cors } from 'spiceflow/cors'
import { env } from 'cloudflare:workers'
import { authMiddleware } from './auth.ts'
import { transformTraces } from './transform-traces.ts'
import { transformLogs } from './transform-logs.ts'
import { transformMetrics } from './transform-metrics.ts'
import { sendToTinybird } from './tinybird-client.ts'
import type { ExportTraceServiceRequest, ExportLogsServiceRequest, ExportMetricsServiceRequest } from './otlp-types.ts'

interface Env {
  TINYBIRD_ENDPOINT: string
  TINYBIRD_TOKEN: string
  ALLOWED_ORIGINS: string
  TRACES_DATASOURCE: string
  LOGS_DATASOURCE: string
  GAUGE_DATASOURCE: string
  SUM_DATASOURCE: string
  HISTOGRAM_DATASOURCE: string
  EXPONENTIAL_HISTOGRAM_DATASOURCE: string
}

function getEnv(): Env {
  return env as unknown as Env
}

const app = new Spiceflow()
  .use(
    cors({
      origin: '*',
      allowMethods: ['POST'],
      allowHeaders: ['content-type', 'x-api-key'],
      maxAge: 86400,
    }),
  )
  .use(authMiddleware)
  .post('/v1/traces', async ({ request, waitUntil }) => {
    const body = (await request.json()) as ExportTraceServiceRequest
    const ndjson = transformTraces(body)

    if (ndjson) {
      const e = getEnv()
      waitUntil(
        sendToTinybird(
          e.TINYBIRD_ENDPOINT,
          e.TINYBIRD_TOKEN,
          e.TRACES_DATASOURCE ?? 'traces',
          ndjson,
        ),
      )
    }

    return {}
  })
  .post('/v1/logs', async ({ request, waitUntil }) => {
    const body = (await request.json()) as ExportLogsServiceRequest
    const ndjson = transformLogs(body)

    if (ndjson) {
      const e = getEnv()
      waitUntil(
        sendToTinybird(
          e.TINYBIRD_ENDPOINT,
          e.TINYBIRD_TOKEN,
          e.LOGS_DATASOURCE ?? 'logs',
          ndjson,
        ),
      )
    }

    return {}
  })
  .post('/v1/metrics', async ({ request, waitUntil }) => {
    const body = (await request.json()) as ExportMetricsServiceRequest
    const e = getEnv()
    const payloads = transformMetrics(body, {
      gauge: e.GAUGE_DATASOURCE ?? 'gauge',
      sum: e.SUM_DATASOURCE ?? 'sum',
      histogram: e.HISTOGRAM_DATASOURCE ?? 'histogram',
      exponentialHistogram:
        e.EXPONENTIAL_HISTOGRAM_DATASOURCE ?? 'exponential_histogram',
    })

    const toSend = payloads.filter((p) => p.ndjson.length > 0)
    if (toSend.length > 0) {
      waitUntil(
        Promise.all(
          toSend.map((p) =>
            sendToTinybird(
              e.TINYBIRD_ENDPOINT,
              e.TINYBIRD_TOKEN,
              p.datasource,
              p.ndjson,
            ),
          ),
        ),
      )
    }

    return {}
  })

export default {
  fetch(request: Request) {
    return app.handle(request)
  },
}

export { app }
