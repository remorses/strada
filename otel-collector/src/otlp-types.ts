// OTLP JSON wire types
// Derived from https://github.com/open-telemetry/opentelemetry-proto
// These match the protobuf JSON mapping of the OTLP proto definitions.
// The @opentelemetry/otlp-transformer package no longer exports these types
// (removed in the OTLP Exporter GA stabilization, PR #5200).

// ─── Shared primitives ───

export interface AnyValue {
  stringValue?: string
  intValue?: string // int64 as string in JSON
  doubleValue?: number
  boolValue?: boolean
  arrayValue?: { values: AnyValue[] }
  kvlistValue?: { values: KeyValue[] }
  bytesValue?: string // base64
}

export interface KeyValue {
  key: string
  value: AnyValue
}

export interface Resource {
  attributes?: KeyValue[]
  droppedAttributesCount?: number
}

export interface InstrumentationScope {
  name?: string
  version?: string
  attributes?: KeyValue[]
  droppedAttributesCount?: number
}

// ─── Traces ───

export interface ExportTraceServiceRequest {
  resourceSpans?: ResourceSpans[]
}

export interface ResourceSpans {
  resource?: Resource
  scopeSpans?: ScopeSpans[]
  schemaUrl?: string
}

export interface ScopeSpans {
  scope?: InstrumentationScope
  spans?: Span[]
  schemaUrl?: string
}

export interface Span {
  traceId: string // hex
  spanId: string // hex
  parentSpanId?: string
  traceState?: string
  name: string
  kind?: number // 0=UNSPECIFIED, 1=INTERNAL, 2=SERVER, 3=CLIENT, 4=PRODUCER, 5=CONSUMER
  startTimeUnixNano: string // int64 as string
  endTimeUnixNano: string
  attributes?: KeyValue[]
  droppedAttributesCount?: number
  events?: SpanEvent[]
  droppedEventsCount?: number
  links?: SpanLink[]
  droppedLinksCount?: number
  status?: SpanStatus
  flags?: number
}

export interface SpanEvent {
  timeUnixNano: string
  name: string
  attributes?: KeyValue[]
  droppedAttributesCount?: number
}

export interface SpanLink {
  traceId: string
  spanId: string
  traceState?: string
  attributes?: KeyValue[]
  droppedAttributesCount?: number
  flags?: number
}

export interface SpanStatus {
  code?: number // 0=UNSET, 1=OK, 2=ERROR
  message?: string
}

// ─── Logs ───

export interface ExportLogsServiceRequest {
  resourceLogs?: ResourceLogs[]
}

export interface ResourceLogs {
  resource?: Resource
  scopeLogs?: ScopeLogs[]
  schemaUrl?: string
}

export interface ScopeLogs {
  scope?: InstrumentationScope
  logRecords?: LogRecord[]
  schemaUrl?: string
}

export interface LogRecord {
  timeUnixNano?: string
  observedTimeUnixNano?: string
  severityNumber?: number // 1-24
  severityText?: string
  body?: AnyValue
  attributes?: KeyValue[]
  droppedAttributesCount?: number
  traceId?: string
  spanId?: string
  flags?: number
  eventName?: string
}

// ─── Metrics ───

export interface ExportMetricsServiceRequest {
  resourceMetrics?: ResourceMetrics[]
}

export interface ResourceMetrics {
  resource?: Resource
  scopeMetrics?: ScopeMetrics[]
  schemaUrl?: string
}

export interface ScopeMetrics {
  scope?: InstrumentationScope
  metrics?: Metric[]
  schemaUrl?: string
}

export interface Metric {
  name: string
  description?: string
  unit?: string
  gauge?: { dataPoints: NumberDataPoint[] }
  sum?: {
    dataPoints: NumberDataPoint[]
    aggregationTemporality: number
    isMonotonic?: boolean
  }
  histogram?: {
    dataPoints: HistogramDataPoint[]
    aggregationTemporality: number
  }
  exponentialHistogram?: {
    dataPoints: ExponentialHistogramDataPoint[]
    aggregationTemporality: number
  }
  summary?: { dataPoints: SummaryDataPoint[] }
}

export interface NumberDataPoint {
  attributes?: KeyValue[]
  startTimeUnixNano?: string
  timeUnixNano: string
  asDouble?: number
  asInt?: string // int64 as string
  exemplars?: Exemplar[]
  flags?: number
}

export interface HistogramDataPoint {
  attributes?: KeyValue[]
  startTimeUnixNano?: string
  timeUnixNano: string
  count: string // uint64 as string
  sum?: number
  bucketCounts?: string[] // uint64[] as string[]
  explicitBounds?: number[]
  exemplars?: Exemplar[]
  flags?: number
  min?: number
  max?: number
}

export interface ExponentialHistogramDataPoint {
  attributes?: KeyValue[]
  startTimeUnixNano?: string
  timeUnixNano: string
  count: string // uint64 as string
  sum?: number
  scale: number
  zeroCount?: string // uint64 as string
  positive?: ExponentialBuckets
  negative?: ExponentialBuckets
  exemplars?: Exemplar[]
  flags?: number
  min?: number
  max?: number
}

export interface ExponentialBuckets {
  offset?: number
  bucketCounts?: string[] // uint64[] as string[]
}

export interface SummaryDataPoint {
  attributes?: KeyValue[]
  startTimeUnixNano?: string
  timeUnixNano: string
  count: string
  sum?: number
  quantileValues?: { quantile: number; value: number }[]
  flags?: number
}

export interface Exemplar {
  filteredAttributes?: KeyValue[]
  timeUnixNano: string
  asDouble?: number
  asInt?: string
  spanId?: string
  traceId?: string
}
