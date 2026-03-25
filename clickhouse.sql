-- ClickHouse DDL for Strada's OTel schema.
--
-- SOURCE OF TRUTH: The Tinybird datasource files in tinybird/datasources/ are
-- the canonical schema definitions. This file is a convenience translation for
-- users running Strada against a generic ClickHouse server (not Tinybird).
--
-- If you modify the schema, edit the .datasource files first, then update this
-- file to match. Never edit this file without updating the datasource files.
--
-- Database: create your own or use `default`. The worker's CLICKHOUSE_DATABASE
-- env var controls which database it writes to.

-- ============================================================================
-- TRACES
-- ============================================================================

CREATE TABLE IF NOT EXISTS otel_traces
(
    `TenantId`            LowCardinality(String) CODEC(ZSTD(1)),
    `Timestamp`           DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `TraceId`             String                 CODEC(ZSTD(1)),
    `SpanId`              String                 CODEC(ZSTD(1)),
    `ParentSpanId`        String                 CODEC(ZSTD(1)),
    `TraceState`          String                 CODEC(ZSTD(1)),
    `SpanName`            LowCardinality(String) CODEC(ZSTD(1)),
    `SpanKind`            LowCardinality(String) CODEC(ZSTD(1)),
    `ServiceName`         LowCardinality(String) CODEC(ZSTD(1)),
    `ResourceSchemaUrl`   String                 CODEC(ZSTD(1)),
    `ResourceAttributes`  Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeSchemaUrl`      String                 CODEC(ZSTD(1)),
    `ScopeName`           String                 CODEC(ZSTD(1)),
    `ScopeVersion`        String                 CODEC(ZSTD(1)),
    `ScopeAttributes`     Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `Duration`            UInt64                 CODEC(ZSTD(1)),
    `StatusCode`          LowCardinality(String) CODEC(ZSTD(1)),
    `StatusMessage`       String                 CODEC(ZSTD(1)),
    `SpanAttributes`      Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `EventsTimestamp`     Array(DateTime64(9))   CODEC(ZSTD(1)),
    `EventsName`          Array(LowCardinality(String)) CODEC(ZSTD(1)),
    `EventsAttributes`    Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `LinksTraceId`        Array(String)          CODEC(ZSTD(1)),
    `LinksSpanId`         Array(String)          CODEC(ZSTD(1)),
    `LinksTraceState`     Array(String)          CODEC(ZSTD(1)),
    `LinksAttributes`     Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),

    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_key mapKeys(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_value mapValues(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_duration Duration TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (TenantId, ServiceName, SpanName, toDateTime(Timestamp))
SETTINGS index_granularity = 8192;

-- ============================================================================
-- TRACES: TraceId → timestamp range lookup (materialized view)
-- ============================================================================

CREATE TABLE IF NOT EXISTS otel_traces_trace_id_ts
(
    `TenantId` LowCardinality(String),
    `TraceId`  String,
    `Start`    DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `End`      DateTime64(9) CODEC(Delta(8), ZSTD(1))
)
ENGINE = MergeTree
ORDER BY (TenantId, TraceId, toUnixTimestamp(Start));

CREATE MATERIALIZED VIEW IF NOT EXISTS otel_traces_trace_id_ts_mv
TO otel_traces_trace_id_ts
AS
SELECT
    TenantId,
    TraceId,
    min(Timestamp) AS Start,
    max(Timestamp) AS End
FROM otel_traces
WHERE TraceId != ''
GROUP BY TenantId, TraceId;

-- ============================================================================
-- LOGS
-- ============================================================================

CREATE TABLE IF NOT EXISTS otel_logs
(
    `TenantId`            LowCardinality(String) CODEC(ZSTD(1)),
    `Timestamp`           DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `TimestampTime`       DateTime DEFAULT toDateTime(Timestamp),
    `TraceId`             String                 CODEC(ZSTD(1)),
    `SpanId`              String                 CODEC(ZSTD(1)),
    `TraceFlags`          UInt8                  CODEC(ZSTD(1)),
    `SeverityText`        LowCardinality(String) CODEC(ZSTD(1)),
    `SeverityNumber`      UInt8                  CODEC(ZSTD(1)),
    `ServiceName`         LowCardinality(String) CODEC(ZSTD(1)),
    `Body`                String                 CODEC(ZSTD(1)),
    `ResourceSchemaUrl`   String                 CODEC(ZSTD(1)),
    `ResourceAttributes`  Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeSchemaUrl`      String                 CODEC(ZSTD(1)),
    `ScopeName`           String                 CODEC(ZSTD(1)),
    `ScopeVersion`        String                 CODEC(ZSTD(1)),
    `ScopeAttributes`     Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `LogAttributes`       Map(LowCardinality(String), String) CODEC(ZSTD(1)),

    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_log_attr_key mapKeys(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_log_attr_value mapValues(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_body Body TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 8
)
ENGINE = MergeTree
PARTITION BY toDate(TimestampTime)
ORDER BY (TenantId, ServiceName, TimestampTime, Timestamp)
SETTINGS index_granularity = 8192;

-- ============================================================================
-- ERRORS (extracted from logs and traces by the worker)
-- ============================================================================

CREATE TABLE IF NOT EXISTS otel_errors
(
    `TenantId`              LowCardinality(String) CODEC(ZSTD(1)),
    `Timestamp`             DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `TraceId`               String                 CODEC(ZSTD(1)),
    `SpanId`                String                 CODEC(ZSTD(1)),
    `ServiceName`           LowCardinality(String) CODEC(ZSTD(1)),
    `ExceptionType`         LowCardinality(String) CODEC(ZSTD(1)),
    `ExceptionMessage`      String                 CODEC(ZSTD(1)),
    `ExceptionStacktrace`   String                 CODEC(ZSTD(1)),
    `ExceptionFrames`       String                 CODEC(ZSTD(1)),
    `Fingerprint`           Array(String)          CODEC(ZSTD(1)),
    `FingerprintHash`       String                 CODEC(ZSTD(1)),
    `MechanismType`         LowCardinality(String) CODEC(ZSTD(1)),
    `MechanismHandled`      Bool                   CODEC(ZSTD(1)),
    `DebugId`               String                 CODEC(ZSTD(1)),
    `Level`                 LowCardinality(String) CODEC(ZSTD(1)),
    `Release`               LowCardinality(String) CODEC(ZSTD(1)),
    `Environment`           LowCardinality(String) CODEC(ZSTD(1)),
    `Tags`                  Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ResourceAttributes`    Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeAttributes`       Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `SourceSignal`          LowCardinality(String) CODEC(ZSTD(1)),

    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_fingerprint_hash FingerprintHash TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_exception_type ExceptionType TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_tag_key mapKeys(Tags) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_tag_value mapValues(Tags) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (TenantId, ServiceName, FingerprintHash, toDateTime(Timestamp))
SETTINGS index_granularity = 8192;

-- ============================================================================
-- METRICS: Gauge
-- ============================================================================

CREATE TABLE IF NOT EXISTS otel_metrics_gauge
(
    `TenantId`                    LowCardinality(String) CODEC(ZSTD(1)),
    `ResourceAttributes`          Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ResourceSchemaUrl`           String                 CODEC(ZSTD(1)),
    `ScopeName`                   String                 CODEC(ZSTD(1)),
    `ScopeVersion`                String                 CODEC(ZSTD(1)),
    `ScopeAttributes`             Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeSchemaUrl`              String                 CODEC(ZSTD(1)),
    `ServiceName`                 String DEFAULT 'unknown' CODEC(ZSTD(1)),
    `MetricName`                  LowCardinality(String) CODEC(ZSTD(1)),
    `MetricDescription`           String                 CODEC(ZSTD(1)),
    `MetricUnit`                  String                 CODEC(ZSTD(1)),
    `Attributes`                  Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `StartTimeUnix`               DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `TimeUnix`                    DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `Value`                       Float64                CODEC(ZSTD(1)),
    `Flags`                       UInt8                  CODEC(ZSTD(1)),
    `ExemplarsTraceId`            Array(String)          CODEC(ZSTD(1)),
    `ExemplarsSpanId`             Array(String)          CODEC(ZSTD(1)),
    `ExemplarsTimestamp`          Array(DateTime64(9))   CODEC(ZSTD(1)),
    `ExemplarsValue`              Array(Float64)         CODEC(ZSTD(1)),
    `ExemplarsFilteredAttributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),

    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (TenantId, ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
SETTINGS index_granularity = 8192;

-- ============================================================================
-- METRICS: Sum (counters)
-- ============================================================================

CREATE TABLE IF NOT EXISTS otel_metrics_sum
(
    `TenantId`                    LowCardinality(String) CODEC(ZSTD(1)),
    `ResourceAttributes`          Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ResourceSchemaUrl`           String                 CODEC(ZSTD(1)),
    `ScopeName`                   String                 CODEC(ZSTD(1)),
    `ScopeVersion`                String                 CODEC(ZSTD(1)),
    `ScopeAttributes`             Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeSchemaUrl`              String                 CODEC(ZSTD(1)),
    `ServiceName`                 String DEFAULT 'unknown' CODEC(ZSTD(1)),
    `MetricName`                  LowCardinality(String) CODEC(ZSTD(1)),
    `MetricDescription`           String                 CODEC(ZSTD(1)),
    `MetricUnit`                  String                 CODEC(ZSTD(1)),
    `Attributes`                  Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `StartTimeUnix`               DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `TimeUnix`                    DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `Value`                       Float64                CODEC(ZSTD(1)),
    `Flags`                       UInt8                  CODEC(ZSTD(1)),
    `ExemplarsTraceId`            Array(String)          CODEC(ZSTD(1)),
    `ExemplarsSpanId`             Array(String)          CODEC(ZSTD(1)),
    `ExemplarsTimestamp`          Array(DateTime64(9))   CODEC(ZSTD(1)),
    `ExemplarsValue`              Array(Float64)         CODEC(ZSTD(1)),
    `ExemplarsFilteredAttributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `AggregationTemporality`      Int32                  CODEC(ZSTD(1)),
    `IsMonotonic`                 Bool                   CODEC(Delta, ZSTD(1)),

    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (TenantId, ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
SETTINGS index_granularity = 8192;

-- ============================================================================
-- METRICS: Histogram
-- ============================================================================

CREATE TABLE IF NOT EXISTS otel_metrics_histogram
(
    `TenantId`                    LowCardinality(String) CODEC(ZSTD(1)),
    `ResourceAttributes`          Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ResourceSchemaUrl`           String                 CODEC(ZSTD(1)),
    `ScopeName`                   String                 CODEC(ZSTD(1)),
    `ScopeVersion`                String                 CODEC(ZSTD(1)),
    `ScopeAttributes`             Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeSchemaUrl`              String                 CODEC(ZSTD(1)),
    `ServiceName`                 String DEFAULT 'unknown' CODEC(ZSTD(1)),
    `MetricName`                  LowCardinality(String) CODEC(ZSTD(1)),
    `MetricDescription`           String                 CODEC(ZSTD(1)),
    `MetricUnit`                  String                 CODEC(ZSTD(1)),
    `Attributes`                  Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `StartTimeUnix`               DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `TimeUnix`                    DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `Count`                       UInt64                 CODEC(Delta, ZSTD(1)),
    `Sum`                         Float64                CODEC(ZSTD(1)),
    `BucketCounts`                Array(UInt64)          CODEC(ZSTD(1)),
    `ExplicitBounds`              Array(Float64)         CODEC(ZSTD(1)),
    `ExemplarsTraceId`            Array(String)          CODEC(ZSTD(1)),
    `ExemplarsSpanId`             Array(String)          CODEC(ZSTD(1)),
    `ExemplarsTimestamp`          Array(DateTime64(9))   CODEC(ZSTD(1)),
    `ExemplarsValue`              Array(Float64)         CODEC(ZSTD(1)),
    `ExemplarsFilteredAttributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `Flags`                       UInt8                  CODEC(ZSTD(1)),
    `Min`                         Nullable(Float64)      CODEC(ZSTD(1)),
    `Max`                         Nullable(Float64)      CODEC(ZSTD(1)),
    `AggregationTemporality`      Int32                  CODEC(ZSTD(1)),

    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (TenantId, ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
SETTINGS index_granularity = 8192;

-- ============================================================================
-- METRICS: Exponential Histogram
-- ============================================================================

CREATE TABLE IF NOT EXISTS otel_metrics_exponential_histogram
(
    `TenantId`                    LowCardinality(String) CODEC(ZSTD(1)),
    `ResourceAttributes`          Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ResourceSchemaUrl`           String                 CODEC(ZSTD(1)),
    `ScopeName`                   String                 CODEC(ZSTD(1)),
    `ScopeVersion`                String                 CODEC(ZSTD(1)),
    `ScopeAttributes`             Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeSchemaUrl`              String                 CODEC(ZSTD(1)),
    `ServiceName`                 String DEFAULT 'unknown' CODEC(ZSTD(1)),
    `MetricName`                  LowCardinality(String) CODEC(ZSTD(1)),
    `MetricDescription`           String                 CODEC(ZSTD(1)),
    `MetricUnit`                  String                 CODEC(ZSTD(1)),
    `Attributes`                  Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `StartTimeUnix`               DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `TimeUnix`                    DateTime64(9)          CODEC(Delta(8), ZSTD(1)),
    `Count`                       UInt64                 CODEC(Delta, ZSTD(1)),
    `Sum`                         Float64                CODEC(ZSTD(1)),
    `Scale`                       Int32                  CODEC(ZSTD(1)),
    `ZeroCount`                   UInt64                 CODEC(ZSTD(1)),
    `PositiveOffset`              Int32                  CODEC(ZSTD(1)),
    `PositiveBucketCounts`        Array(UInt64)          CODEC(ZSTD(1)),
    `NegativeOffset`              Int32                  CODEC(ZSTD(1)),
    `NegativeBucketCounts`        Array(UInt64)          CODEC(ZSTD(1)),
    `ExemplarsTraceId`            Array(String)          CODEC(ZSTD(1)),
    `ExemplarsSpanId`             Array(String)          CODEC(ZSTD(1)),
    `ExemplarsTimestamp`          Array(DateTime64(9))   CODEC(ZSTD(1)),
    `ExemplarsValue`              Array(Float64)         CODEC(ZSTD(1)),
    `ExemplarsFilteredAttributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `Flags`                       UInt8                  CODEC(ZSTD(1)),
    `Min`                         Nullable(Float64)      CODEC(ZSTD(1)),
    `Max`                         Nullable(Float64)      CODEC(ZSTD(1)),
    `AggregationTemporality`      Int32                  CODEC(ZSTD(1)),

    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (TenantId, ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
SETTINGS index_granularity = 8192;
