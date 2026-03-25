// Transform OTLP logs to Tinybird NDJSON.
// Matches the logic in the Go exporter's internal/logs.go:32-81.

import type { ExportLogsServiceRequest } from './otlp-types.ts'
import type { TinybirdLog } from './tinybird-types.ts'
import {
  convertAttributes,
  getServiceName,
  nanosToRFC3339,
  anyValueToString,
} from './transform-attributes.ts'

export function transformLogs(body: ExportLogsServiceRequest, tenantId: string): string {
  const rows: string[] = []

  for (const rl of body.resourceLogs ?? []) {
    const resourceAttrs = convertAttributes(rl.resource?.attributes)
    const serviceName = getServiceName(rl.resource?.attributes)

    for (const sl of rl.scopeLogs ?? []) {
      const scopeAttrs = convertAttributes(sl.scope?.attributes)

      for (const log of sl.logRecords ?? []) {
        // Match Go exporter: fall back to observedTimeUnixNano if timeUnixNano
        // is missing or zero.
        const timestamp =
          log.timeUnixNano && log.timeUnixNano !== '0'
            ? log.timeUnixNano
            : (log.observedTimeUnixNano ?? '0')

        const row: TinybirdLog = {
          tenant_id: tenantId,
          resource_schema_url: rl.schemaUrl ?? '',
          resource_attributes: resourceAttrs,
          service_name: serviceName,
          scope_schema_url: sl.schemaUrl ?? '',
          scope_name: sl.scope?.name ?? '',
          scope_version: sl.scope?.version ?? '',
          scope_attributes: scopeAttrs,
          timestamp: nanosToRFC3339(timestamp),
          trace_id: log.traceId ?? '',
          span_id: log.spanId ?? '',
          flags: log.flags ?? 0,
          severity_text: log.severityText ?? '',
          severity_number: log.severityNumber ?? 0,
          log_attributes: convertAttributes(log.attributes),
          body: anyValueToString(log.body),
        }
        rows.push(JSON.stringify(row))
      }
    }
  }

  return rows.length > 0 ? rows.join('\n') + '\n' : ''
}
