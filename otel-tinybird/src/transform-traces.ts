// Transform OTLP traces to Tinybird NDJSON.
// Matches the logic in the Go exporter's internal/traces.go:74-128.

import type { ExportTraceServiceRequest } from './otlp-types.ts'
import type { TinybirdTrace } from './tinybird-types.ts'
import {
  convertAttributes,
  getServiceName,
  nanosToRFC3339,
} from './transform-attributes.ts'

const SPAN_KIND_MAP: Record<number, string> = {
  0: 'SPAN_KIND_UNSPECIFIED',
  1: 'SPAN_KIND_INTERNAL',
  2: 'SPAN_KIND_SERVER',
  3: 'SPAN_KIND_CLIENT',
  4: 'SPAN_KIND_PRODUCER',
  5: 'SPAN_KIND_CONSUMER',
}

const STATUS_CODE_MAP: Record<number, string> = {
  0: 'STATUS_CODE_UNSET',
  1: 'STATUS_CODE_OK',
  2: 'STATUS_CODE_ERROR',
}

export function transformTraces(body: ExportTraceServiceRequest): string {
  const rows: string[] = []

  for (const rs of body.resourceSpans ?? []) {
    const resourceAttrs = convertAttributes(rs.resource?.attributes)
    const serviceName = getServiceName(rs.resource?.attributes)

    for (const ss of rs.scopeSpans ?? []) {
      const scopeAttrs = convertAttributes(ss.scope?.attributes)

      for (const span of ss.spans ?? []) {
        const startNano = BigInt(span.startTimeUnixNano)
        const endNano = BigInt(span.endTimeUnixNano)

        const row: TinybirdTrace = {
          resource_schema_url: rs.schemaUrl ?? '',
          resource_attributes: resourceAttrs,
          service_name: serviceName,
          scope_schema_url: ss.schemaUrl ?? '',
          scope_name: ss.scope?.name ?? '',
          scope_version: ss.scope?.version ?? '',
          scope_attributes: scopeAttrs,
          trace_id: span.traceId,
          span_id: span.spanId,
          parent_span_id: span.parentSpanId ?? '',
          trace_state: span.traceState ?? '',
          trace_flags: span.flags ?? 0,
          span_name: span.name,
          span_kind: SPAN_KIND_MAP[span.kind ?? 0] ?? 'SPAN_KIND_UNSPECIFIED',
          span_attributes: convertAttributes(span.attributes),
          start_time: nanosToRFC3339(span.startTimeUnixNano),
          end_time: nanosToRFC3339(span.endTimeUnixNano),
          duration: Number(endNano - startNano),
          status_code:
            STATUS_CODE_MAP[span.status?.code ?? 0] ?? 'STATUS_CODE_UNSET',
          status_message: span.status?.message ?? '',
          events_timestamp: (span.events ?? []).map((e) =>
            nanosToRFC3339(e.timeUnixNano),
          ),
          events_name: (span.events ?? []).map((e) => e.name),
          events_attributes: (span.events ?? []).map((e) =>
            convertAttributes(e.attributes),
          ),
          links_trace_id: (span.links ?? []).map((l) => l.traceId),
          links_span_id: (span.links ?? []).map((l) => l.spanId),
          links_trace_state: (span.links ?? []).map(
            (l) => l.traceState ?? '',
          ),
          links_attributes: (span.links ?? []).map((l) =>
            convertAttributes(l.attributes),
          ),
        }
        rows.push(JSON.stringify(row))
      }
    }
  }

  return rows.length > 0 ? rows.join('\n') + '\n' : ''
}
