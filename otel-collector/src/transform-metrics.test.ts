import { describe, it, expect } from 'vitest'
import { transformMetrics } from './transform-metrics.ts'
import type { ExportMetricsServiceRequest } from './otlp-types.ts'

const datasourceNames = {
  gauge: 'otel_metrics_gauge',
  sum: 'otel_metrics_sum',
  histogram: 'otel_metrics_histogram',
  exponentialHistogram: 'otel_metrics_exponential_histogram',
}

describe('transformMetrics', () => {
  it('handles missing optional histogram and exponential fields', () => {
    const body: ExportMetricsServiceRequest = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'request.duration',
                  histogram: {
                    aggregationTemporality: 2,
                    dataPoints: [
                      {
                        timeUnixNano: '1544712660123456789',
                        count: '10',
                      },
                    ],
                  },
                },
                {
                  name: 'request.size',
                  exponentialHistogram: {
                    aggregationTemporality: 2,
                    dataPoints: [
                      {
                        timeUnixNano: '1544712660123456789',
                        count: '5',
                        scale: 1,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    }

    const payloads = transformMetrics(body, 'acme', datasourceNames)

    const histogramPayload = payloads.find(
      (payload) => payload.signal === 'metrics_histogram',
    )
    const expHistogramPayload = payloads.find(
      (payload) => payload.signal === 'metrics_exponential_histogram',
    )

    const histogramRow = JSON.parse(histogramPayload!.ndjson.trim())
    const expHistogramRow = JSON.parse(expHistogramPayload!.ndjson.trim())

    expect(histogramRow.count).toBe(10)
    expect(histogramRow.bucket_counts).toEqual([])
    expect(histogramRow.explicit_bounds).toEqual([])

    expect(expHistogramRow.count).toBe(5)
    expect(expHistogramRow.zero_count).toBe(0)
    expect(expHistogramRow.positive_offset).toBe(0)
    expect(expHistogramRow.positive_bucket_counts).toEqual([])
    expect(expHistogramRow.negative_offset).toBe(0)
    expect(expHistogramRow.negative_bucket_counts).toEqual([])
  })

  it('preserves full precision for large uint64 values', () => {
    const maxUInt64 = '18446744073709551615'

    const body: ExportMetricsServiceRequest = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'large.histogram',
                  histogram: {
                    aggregationTemporality: 2,
                    dataPoints: [
                      {
                        timeUnixNano: '1544712660123456789',
                        count: maxUInt64,
                        bucketCounts: [maxUInt64, '42'],
                        explicitBounds: [1, 2],
                      },
                    ],
                  },
                },
                {
                  name: 'large.exp.histogram',
                  exponentialHistogram: {
                    aggregationTemporality: 2,
                    dataPoints: [
                      {
                        timeUnixNano: '1544712660123456789',
                        count: maxUInt64,
                        scale: 1,
                        zeroCount: maxUInt64,
                        positive: { offset: 3, bucketCounts: [maxUInt64] },
                        negative: { offset: -1, bucketCounts: ['7'] },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    }

    const payloads = transformMetrics(body, 'acme', datasourceNames)

    const histogramPayload = payloads.find(
      (payload) => payload.signal === 'metrics_histogram',
    )
    const expHistogramPayload = payloads.find(
      (payload) => payload.signal === 'metrics_exponential_histogram',
    )

    const histogramRow = JSON.parse(histogramPayload!.ndjson.trim())
    const expHistogramRow = JSON.parse(expHistogramPayload!.ndjson.trim())

    expect(histogramRow.count).toBe(maxUInt64)
    expect(histogramRow.bucket_counts[0]).toBe(maxUInt64)
    expect(histogramRow.bucket_counts[1]).toBe(42)

    expect(expHistogramRow.count).toBe(maxUInt64)
    expect(expHistogramRow.zero_count).toBe(maxUInt64)
    expect(expHistogramRow.positive_bucket_counts[0]).toBe(maxUInt64)
    expect(expHistogramRow.negative_bucket_counts[0]).toBe(7)
  })
})
