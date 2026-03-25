// Transform OTLP metrics to Tinybird NDJSON.
// Matches the logic in the Go exporter's internal/metrics.go:147-283.
// Metrics are split into 4 datasources: gauge, sum, histogram, exponential_histogram.

import type { ExportMetricsServiceRequest } from './otlp-types.ts'
import type {
  TinybirdGauge,
  TinybirdSum,
  TinybirdHistogram,
  TinybirdExponentialHistogram,
} from './tinybird-types.ts'
import {
  convertAttributes,
  convertExemplars,
  getServiceName,
  getNumberValue,
  nanosToRFC3339,
} from './transform-attributes.ts'

export interface MetricsPayload {
  datasource: string
  ndjson: string
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
        }

        if (metric.gauge) {
          for (const dp of metric.gauge.dataPoints) {
            const exemplars = convertExemplars(dp.exemplars)
            const row: TinybirdGauge = {
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
          for (const dp of metric.sum.dataPoints) {
            const exemplars = convertExemplars(dp.exemplars)
            const row: TinybirdSum = {
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
          for (const dp of metric.histogram.dataPoints) {
            const exemplars = convertExemplars(dp.exemplars)
            const row: TinybirdHistogram = {
              ...base,
              ...exemplars,
              start_timestamp: nanosToRFC3339(dp.startTimeUnixNano ?? '0'),
              timestamp: nanosToRFC3339(dp.timeUnixNano),
              flags: dp.flags ?? 0,
              metric_attributes: convertAttributes(dp.attributes),
              count: Number(dp.count),
              sum: dp.sum ?? 0,
              bucket_counts: dp.bucketCounts.map(Number),
              explicit_bounds: dp.explicitBounds,
              min: dp.min,
              max: dp.max,
              aggregation_temporality:
                metric.histogram!.aggregationTemporality,
            }
            histogramRows.push(JSON.stringify(row))
          }
        }

        if (metric.exponentialHistogram) {
          for (const dp of metric.exponentialHistogram.dataPoints) {
            const exemplars = convertExemplars(dp.exemplars)
            const row: TinybirdExponentialHistogram = {
              ...base,
              ...exemplars,
              start_timestamp: nanosToRFC3339(dp.startTimeUnixNano ?? '0'),
              timestamp: nanosToRFC3339(dp.timeUnixNano),
              flags: dp.flags ?? 0,
              metric_attributes: convertAttributes(dp.attributes),
              count: Number(dp.count),
              sum: dp.sum ?? 0,
              scale: dp.scale,
              zero_count: Number(dp.zeroCount),
              positive_offset: dp.positive.offset,
              positive_bucket_counts: dp.positive.bucketCounts.map(Number),
              negative_offset: dp.negative.offset,
              negative_bucket_counts: dp.negative.bucketCounts.map(Number),
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
    { datasource: datasourceNames.gauge, ndjson: toNdjson(gaugeRows) },
    { datasource: datasourceNames.sum, ndjson: toNdjson(sumRows) },
    {
      datasource: datasourceNames.histogram,
      ndjson: toNdjson(histogramRows),
    },
    {
      datasource: datasourceNames.exponentialHistogram,
      ndjson: toNdjson(expHistogramRows),
    },
  ]
}
