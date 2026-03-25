// OTLP-to-Tinybird proxy on Cloudflare Workers.
// Receives OTLP HTTP/JSON traces, logs, and metrics from any OTEL SDK
// and forwards them to the Tinybird Events API as NDJSON.
//
// Multi-tenancy: tenant_id is extracted from the hostname.
// Each tenant gets a subdomain: {tenant}-ingest.stradametrics.com
// The worker parses the hostname to get the tenant_id and injects it
// into every NDJSON row. No KV or DB lookup needed.

import { Spiceflow } from 'spiceflow'
import { cors } from 'spiceflow/cors'
import { env } from 'cloudflare:workers'
import { getTenantId } from './get-tenant-id.ts'
import { transformTraces } from './transform-traces.ts'
import { transformLogs } from './transform-logs.ts'
import { transformMetrics } from './transform-metrics.ts'
import { sendToTinybird } from './tinybird-client.ts'
import { extractErrorsFromTraces, extractErrorsFromLogs } from './extract-errors.ts'
import type { ExportTraceServiceRequest, ExportLogsServiceRequest, ExportMetricsServiceRequest } from './otlp-types.ts'

interface Env {
  TINYBIRD_ENDPOINT: string
  TINYBIRD_TOKEN: string
  TRACES_DATASOURCE: string
  LOGS_DATASOURCE: string
  GAUGE_DATASOURCE: string
  SUM_DATASOURCE: string
  HISTOGRAM_DATASOURCE: string
  EXPONENTIAL_HISTOGRAM_DATASOURCE: string
  ERRORS_DATASOURCE: string
}

function getEnv(): Env {
  return env as unknown as Env
}

const app = new Spiceflow()
  .use(
    cors({
      origin: '*',
      allowMethods: ['POST'],
      allowHeaders: ['content-type'],
      maxAge: 86400,
    }),
  )
  .post('/v1/traces', async ({ request, waitUntil }) => {
    const tenantId = getTenantId(request)
    const body = (await request.json()) as ExportTraceServiceRequest
    const e = getEnv()

    const ndjson = transformTraces(body, tenantId)
    if (ndjson) {
      waitUntil(
        sendToTinybird(
          e.TINYBIRD_ENDPOINT,
          e.TINYBIRD_TOKEN,
          e.TRACES_DATASOURCE ?? 'otel_traces',
          ndjson,
        ),
      )
    }

    // Extract exceptions from span events and write to otel_errors
    const errorsNdjson = extractErrorsFromTraces(body, tenantId)
    if (errorsNdjson) {
      waitUntil(
        sendToTinybird(
          e.TINYBIRD_ENDPOINT,
          e.TINYBIRD_TOKEN,
          e.ERRORS_DATASOURCE ?? 'otel_errors',
          errorsNdjson,
        ),
      )
    }

    return {}
  })
  .post('/v1/logs', async ({ request, waitUntil }) => {
    const tenantId = getTenantId(request)
    const body = (await request.json()) as ExportLogsServiceRequest
    const e = getEnv()

    const ndjson = transformLogs(body, tenantId)
    if (ndjson) {
      waitUntil(
        sendToTinybird(
          e.TINYBIRD_ENDPOINT,
          e.TINYBIRD_TOKEN,
          e.LOGS_DATASOURCE ?? 'otel_logs',
          ndjson,
        ),
      )
    }

    // Extract exceptions from log attributes and write to otel_errors
    const errorsNdjson = extractErrorsFromLogs(body, tenantId)
    if (errorsNdjson) {
      waitUntil(
        sendToTinybird(
          e.TINYBIRD_ENDPOINT,
          e.TINYBIRD_TOKEN,
          e.ERRORS_DATASOURCE ?? 'otel_errors',
          errorsNdjson,
        ),
      )
    }

    return {}
  })
  .post('/v1/metrics', async ({ request, waitUntil }) => {
    const tenantId = getTenantId(request)
    const body = (await request.json()) as ExportMetricsServiceRequest
    const e = getEnv()
    const payloads = transformMetrics(body, tenantId, {
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
