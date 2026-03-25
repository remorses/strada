// Tinybird output types matching the Go OTEL collector exporter structs.
// See: opentelemetry-collector-contrib/exporter/tinybirdexporter/internal/

// Matches internal/traces.go:14-44
export interface TinybirdTrace {
  resource_schema_url: string
  resource_attributes: Record<string, string>
  service_name: string
  scope_schema_url: string
  scope_name: string
  scope_version: string
  scope_attributes: Record<string, string>
  trace_id: string
  span_id: string
  parent_span_id: string
  trace_state: string
  trace_flags: number
  span_name: string
  span_kind: string
  span_attributes: Record<string, string>
  start_time: string // RFC3339Nano
  end_time: string
  duration: number // nanoseconds
  status_code: string
  status_message: string
  events_timestamp: string[]
  events_name: string[]
  events_attributes: Record<string, string>[]
  links_trace_id: string[]
  links_span_id: string[]
  links_trace_state: string[]
  links_attributes: Record<string, string>[]
}

// Matches internal/logs.go:14-30
export interface TinybirdLog {
  resource_schema_url: string
  resource_attributes: Record<string, string>
  service_name: string
  scope_schema_url: string
  scope_name: string
  scope_version: string
  scope_attributes: Record<string, string>
  timestamp: string
  trace_id: string
  span_id: string
  flags: number
  severity_text: string
  severity_number: number
  log_attributes: Record<string, string>
  body: string
}

// Matches internal/metrics.go base struct
interface TinybirdBaseMetric {
  resource_schema_url: string
  resource_attributes: Record<string, string>
  service_name: string
  start_timestamp: string
  timestamp: string
  flags: number
  metric_name: string
  metric_description: string
  metric_unit: string
  metric_attributes: Record<string, string>
  scope_name: string
  scope_version: string
  scope_schema_url: string
  scope_attributes: Record<string, string>
  exemplars_filtered_attributes: Record<string, string>[]
  exemplars_timestamp: string[]
  exemplars_value: number[]
  exemplars_span_id: string[]
  exemplars_trace_id: string[]
}

// Matches internal/metrics.go sumMetricSignal
export interface TinybirdSum extends TinybirdBaseMetric {
  value: number
  aggregation_temporality: number
  is_monotonic: boolean
}

// Matches internal/metrics.go gaugeMetricSignal
export interface TinybirdGauge extends TinybirdBaseMetric {
  value: number
}

// Matches internal/metrics.go histogramMetricSignal
export interface TinybirdHistogram extends TinybirdBaseMetric {
  count: number
  sum: number
  bucket_counts: number[]
  explicit_bounds: number[]
  min?: number
  max?: number
  aggregation_temporality: number
}

// Matches internal/metrics.go exponentialHistogramMetricSignal
export interface TinybirdExponentialHistogram extends TinybirdBaseMetric {
  count: number
  sum: number
  scale: number
  zero_count: number
  positive_offset: number
  positive_bucket_counts: number[]
  negative_offset: number
  negative_bucket_counts: number[]
  min?: number
  max?: number
  aggregation_temporality: number
}
