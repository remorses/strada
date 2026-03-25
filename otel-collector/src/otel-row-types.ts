// OTel row types matching the standard OpenTelemetry ClickHouse exporter schema.
// Column names follow the OTel ClickHouse convention (PascalCase) defined in:
// https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/clickhouseexporter/internal/sqltemplates
//
// These types use snake_case field names because the otel-collector outputs JSON
// in snake_case. For Tinybird, the `json:$.snake_case` mapping in .datasource files
// converts to PascalCase columns on ingest. For ClickHouse, the field-mapping module
// remaps keys before INSERT.
//
// tenant_id is a Strada addition for multi-tenancy (not part of the OTel standard).

// Matches the OTel ClickHouse traces table schema, with tenant_id added.
export interface OtelTraceRow {
  tenant_id: string
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

// Matches the OTel ClickHouse logs table schema, with tenant_id added.
export interface OtelLogRow {
  tenant_id: string
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
  event_name: string
}

// Denormalized error row extracted from logs (exception.* attributes) or
// traces (span events named "exception"). Written to the otel_errors table.
// This is a Strada-specific table (not part of the OTel ClickHouse exporter).
export interface OtelErrorRow {
  tenant_id: string
  timestamp: string // RFC3339Nano
  trace_id: string
  span_id: string
  service_name: string
  exception_type: string
  exception_message: string
  exception_stacktrace: string
  exception_frames: string // JSON array of structured frames
  fingerprint: string[]
  fingerprint_hash: string // hex hash for GROUP BY
  mechanism_type: string
  mechanism_handled: boolean
  debug_id: string
  level: string // "error", "fatal", "warning"
  release: string
  environment: string
  tags: Record<string, string>
  resource_attributes: Record<string, string>
  scope_attributes: Record<string, string>
  source_signal: string // "log" or "trace"
}

// Matches the OTel ClickHouse metrics base schema, with tenant_id added.
interface OtelBaseMetricRow {
  tenant_id: string
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
  scope_dropped_attr_count: number
  exemplars_filtered_attributes: Record<string, string>[]
  exemplars_timestamp: string[]
  exemplars_value: number[]
  exemplars_span_id: string[]
  exemplars_trace_id: string[]
}

// Matches the OTel ClickHouse sum metrics table schema.
export interface OtelSumRow extends OtelBaseMetricRow {
  value: number
  aggregation_temporality: number
  is_monotonic: boolean
}

// Matches the OTel ClickHouse gauge metrics table schema.
export interface OtelGaugeRow extends OtelBaseMetricRow {
  value: number
}

// Matches the OTel ClickHouse histogram metrics table schema.
export interface OtelHistogramRow extends OtelBaseMetricRow {
  count: number | string
  sum: number
  bucket_counts: Array<number | string>
  explicit_bounds: number[]
  min?: number
  max?: number
  aggregation_temporality: number
}

// Matches the OTel ClickHouse exponential histogram metrics table schema.
export interface OtelExponentialHistogramRow extends OtelBaseMetricRow {
  count: number | string
  sum: number
  scale: number
  zero_count: number | string
  positive_offset: number
  positive_bucket_counts: Array<number | string>
  negative_offset: number
  negative_bucket_counts: Array<number | string>
  min?: number
  max?: number
  aggregation_temporality: number
}
