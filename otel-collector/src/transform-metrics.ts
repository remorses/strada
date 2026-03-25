// Transform OTLP metrics to NDJSON rows matching the OTel ClickHouse schema.
// Matches the logic in the Go exporter's internal/metrics.go:147-283.
// Metrics are split into 4 tables: gauge, sum, histogram, exponential_histogram.

import type { ExportMetricsServiceRequest } from './otlp-types.ts'
import type {
  OtelGaugeRow,
  OtelSumRow,
  OtelHistogramRow,
  OtelExponentialHistogramRow,
} from './otel-row-types.ts'
import {
  convertAttributes,
  convertExemplars,
  getServiceName,
  getNumberValue,
  nanosToRFC3339,
} from './transform-attributes.ts'
import type { SignalKind } from './field-mapping.ts'

export interface MetricsPayload {
  datasource: string
  signal: SignalKind
  ndjson: string
}

function parseIntString(value: string | undefined): number | string {
  if (!value) return 0
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) ? numeric : value
}

export function transformMetrics(
  body: ExportMetricsServiceRequest,
  tenantId: string,
  datasourceNames: {
    gauge: string
    sum: string
    histogram: string
    exponentialHistogram: string
  },
): MetricsPayload[] {
  const gaugeRows: string[] = []
  const sumRows: string[] = []
  const histogramRows: string[] = []
  const expHistogramRows: string[] = []

  for (const rm of body.resourceMetrics ?? []) {
    const resourceAttrs = convertAttributes(rm.resource?.attributes)
    const serviceName = getServiceName(rm.resource?.attributes)
    const schemaUrl = rm.schemaUrl ?? ''

    for (const sm of rm.scopeMetrics ?? []) {
      const scopeAttrs = convertAttributes(sm.scope?.attributes)
      const scopeName = sm.scope?.name ?? ''
      const scopeVersion = sm.scope?.version ?? ''
      const scopeSchemaUrl = sm.schemaUrl ?? ''

      for (const metric of sm.metrics ?? []) {
        const base = {
          tenant_id: tenantId,
          resource_schema_url: schemaUrl,
          resource_attributes: resourceAttrs,
          service_name: serviceName,
          metric_name: metric.name,
          metric_description: metric.description ?? '',
          metric_unit: metric.unit ?? '',
          scope_name: scopeName,
          scope_version: scopeVersion,
          scope_schema_url: scopeSchemaUrl,
          scope_attributes: scopeAttrs,
          scope_dropped_attr_count: sm.scope?.droppedAttributesCount ?? 0,
        }

        if (metric.gauge) {
          for (const dp of metric.gauge.dataPoints ?? []) {
            const exemplars = convertExemplars(dp.exemplars)
            const row: OtelGaugeRow = {
              ...base,
              ...exemplars,
              start_timestamp: nanosToRFC3339(dp.startTimeUnixNano ?? '0'),
              timestamp: nanosToRFC3339(dp.timeUnixNano),
              flags: dp.flags ?? 0,
              metric_attributes: convertAttributes(dp.attributes),
              value: getNumberValue(dp),
            }
            gaugeRows.push(JSON.stringify(row))
          }
        }

        if (metric.sum) {
          for (const dp of metric.sum.dataPoints ?? []) {
            const exemplars = convertExemplars(dp.exemplars)
            const row: OtelSumRow = {
              ...base,
              ...exemplars,
              start_timestamp: nanosToRFC3339(dp.startTimeUnixNano ?? '0'),
              timestamp: nanosToRFC3339(dp.timeUnixNano),
              flags: dp.flags ?? 0,
              metric_attributes: convertAttributes(dp.attributes),
              value: getNumberValue(dp),
              aggregation_temporality: metric.sum!.aggregationTemporality,
              is_monotonic: metric.sum!.isMonotonic ?? false,
            }
            sumRows.push(JSON.stringify(row))
          }
        }

        if (metric.histogram) {
          for (const dp of metric.histogram.dataPoints ?? []) {
            const exemplars = convertExemplars(dp.exemplars)
            const row: OtelHistogramRow = {
              ...base,
              ...exemplars,
              start_timestamp: nanosToRFC3339(dp.startTimeUnixNano ?? '0'),
              timestamp: nanosToRFC3339(dp.timeUnixNano),
              flags: dp.flags ?? 0,
              metric_attributes: convertAttributes(dp.attributes),
              count: parseIntString(dp.count),
              sum: dp.sum ?? 0,
              bucket_counts: (dp.bucketCounts ?? []).map((v) =>
                parseIntString(v),
              ),
              explicit_bounds: dp.explicitBounds ?? [],
              min: dp.min,
              max: dp.max,
              aggregation_temporality:
                metric.histogram!.aggregationTemporality,
            }
            histogramRows.push(JSON.stringify(row))
          }
        }

        if (metric.exponentialHistogram) {
          for (const dp of metric.exponentialHistogram.dataPoints ?? []) {
            const positive = dp.positive ?? {}
            const negative = dp.negative ?? {}
            const exemplars = convertExemplars(dp.exemplars)
            const row: OtelExponentialHistogramRow = {
              ...base,
              ...exemplars,
              start_timestamp: nanosToRFC3339(dp.startTimeUnixNano ?? '0'),
              timestamp: nanosToRFC3339(dp.timeUnixNano),
              flags: dp.flags ?? 0,
              metric_attributes: convertAttributes(dp.attributes),
              count: parseIntString(dp.count),
              sum: dp.sum ?? 0,
              scale: dp.scale,
              zero_count: parseIntString(dp.zeroCount),
              positive_offset: positive.offset ?? 0,
              positive_bucket_counts: (positive.bucketCounts ?? []).map((v) =>
                parseIntString(v),
              ),
              negative_offset: negative.offset ?? 0,
              negative_bucket_counts: (negative.bucketCounts ?? []).map((v) =>
                parseIntString(v),
              ),
              min: dp.min,
              max: dp.max,
              aggregation_temporality:
                metric.exponentialHistogram!.aggregationTemporality,
            }
            expHistogramRows.push(JSON.stringify(row))
          }
        }
      }
    }
  }

  const toNdjson = (rows: string[]) =>
    rows.length > 0 ? rows.join('\n') + '\n' : ''

  return [
    { datasource: datasourceNames.gauge, signal: 'metrics_gauge' as const, ndjson: toNdjson(gaugeRows) },
    { datasource: datasourceNames.sum, signal: 'metrics_sum' as const, ndjson: toNdjson(sumRows) },
    {
      datasource: datasourceNames.histogram,
      signal: 'metrics_histogram' as const,
      ndjson: toNdjson(histogramRows),
    },
    {
      datasource: datasourceNames.exponentialHistogram,
      signal: 'metrics_exponential_histogram' as const,
      ndjson: toNdjson(expHistogramRows),
    },
  ]
}
