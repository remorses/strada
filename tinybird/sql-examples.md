---
title: SQL query examples
description: Example queries to run against the OTel tables via Tinybird Query API (/v0/sql). These replace the pipe endpoints from the upstream tinybird-otel-template — we query directly with SQL instead.
---

All queries below are meant to be sent as raw SQL to Tinybird's Query API:

```
POST https://api.tinybird.co/v0/sql
Authorization: Bearer <JWT>
Content-Type: text/plain

SELECT ... FORMAT JSON
```

The JWT's `filter` field enforces tenant isolation automatically on every query.
You do NOT need to add `WHERE TenantId = '...'` — Tinybird appends it server-side
based on the JWT's filter scope. Since `TenantId` is first in every table's sorting key,
ClickHouse skips all other tenants' data at the granule level.

To filter by service (project) within a tenant, add `WHERE ServiceName = '...'` to any query.

## Logs

### Recent logs

```sql
SELECT
    Timestamp,
    SeverityText,
    ServiceName,
    Body,
    TraceId,
    SpanId,
    LogAttributes,
    ResourceAttributes
FROM otel_logs
WHERE Timestamp >= now() - INTERVAL 1 HOUR
ORDER BY Timestamp DESC
LIMIT 100
FORMAT JSON
```

### Recent logs filtered by severity and service

```sql
SELECT
    Timestamp,
    SeverityText,
    ServiceName,
    Body,
    TraceId,
    SpanId,
    LogAttributes,
    ResourceAttributes
FROM otel_logs
WHERE Timestamp >= '2025-01-01 00:00:00'
  AND Timestamp <= '2025-12-31 23:59:59'
  AND SeverityText = 'ERROR'
  AND ServiceName = 'api-gateway'
ORDER BY Timestamp DESC
LIMIT 1000
FORMAT JSON
```

### Error rate by service

```sql
SELECT
    ServiceName,
    count() AS total_logs,
    countIf(SeverityText IN ('ERROR', 'FATAL')) AS error_logs,
    round(error_logs / total_logs * 100, 2) AS error_rate_percent
FROM otel_logs
WHERE Timestamp >= now() - INTERVAL 24 HOUR
GROUP BY ServiceName
ORDER BY error_rate_percent DESC
FORMAT JSON
```

### Full-text search in log body

```sql
SELECT
    Timestamp,
    SeverityText,
    ServiceName,
    Body
FROM otel_logs
WHERE hasToken(Body, 'timeout')
  AND Timestamp >= now() - INTERVAL 1 HOUR
ORDER BY Timestamp DESC
LIMIT 50
FORMAT JSON
```

### Log volume over time (timeseries)

```sql
SELECT
    toStartOfMinute(Timestamp) AS minute,
    SeverityText,
    count() AS log_count
FROM otel_logs
WHERE Timestamp >= now() - INTERVAL 1 HOUR
GROUP BY minute, SeverityText
ORDER BY minute ASC
FORMAT JSON
```

## Traces

### Get all spans for a trace

```sql
SELECT
    TraceId,
    SpanId,
    ParentSpanId,
    SpanName,
    SpanKind,
    ServiceName,
    Duration / 1000000 AS duration_ms,
    StatusCode,
    StatusMessage,
    Timestamp AS start_time,
    SpanAttributes,
    ResourceAttributes
FROM otel_traces
WHERE TraceId = '<trace_id>'
ORDER BY Timestamp ASC
FORMAT JSON
```

### Slowest operations (p50, p95, p99)

```sql
SELECT
    ServiceName,
    SpanName,
    count() AS span_count,
    quantile(0.5)(Duration) / 1000000 AS p50_ms,
    quantile(0.95)(Duration) / 1000000 AS p95_ms,
    quantile(0.99)(Duration) / 1000000 AS p99_ms,
    max(Duration) / 1000000 AS max_ms
FROM otel_traces
WHERE Timestamp >= now() - INTERVAL 1 HOUR
GROUP BY ServiceName, SpanName
ORDER BY p95_ms DESC
LIMIT 20
FORMAT JSON
```

### Error spans

```sql
SELECT
    TraceId,
    SpanId,
    SpanName,
    ServiceName,
    StatusCode,
    StatusMessage,
    Duration / 1000000 AS duration_ms,
    Timestamp
FROM otel_traces
WHERE StatusCode = 'Error'
  AND Timestamp >= now() - INTERVAL 24 HOUR
ORDER BY Timestamp DESC
LIMIT 100
FORMAT JSON
```

### Trace duration (using materialized view)

```sql
SELECT
    TraceId,
    Start,
    End,
    dateDiff('millisecond', Start, End) AS duration_ms
FROM otel_traces_trace_id_ts
WHERE Start >= now() - INTERVAL 1 HOUR
ORDER BY duration_ms DESC
LIMIT 20
FORMAT JSON
```

### Service dependency map

```sql
SELECT
    t1.ServiceName AS caller_service,
    t2.ServiceName AS callee_service,
    count() AS call_count,
    avg(t2.Duration) / 1000000 AS avg_duration_ms
FROM otel_traces t1
INNER JOIN otel_traces t2
    ON t1.TraceId = t2.TraceId AND t1.SpanId = t2.ParentSpanId
WHERE t1.Timestamp >= now() - INTERVAL 1 HOUR
  AND t2.Timestamp >= now() - INTERVAL 1 HOUR
  AND t1.ServiceName != t2.ServiceName
GROUP BY caller_service, callee_service
ORDER BY call_count DESC
FORMAT JSON
```

## Metrics

### Latest gauge values

```sql
SELECT
    ServiceName,
    MetricName,
    MetricUnit,
    Attributes,
    argMax(Value, TimeUnix) AS latest_value,
    max(TimeUnix) AS last_seen
FROM otel_metrics_gauge
WHERE TimeUnix >= now() - INTERVAL 1 HOUR
GROUP BY ServiceName, MetricName, MetricUnit, Attributes
ORDER BY ServiceName, MetricName
FORMAT JSON
```

### Counter rate (sum metrics)

```sql
SELECT
    ServiceName,
    MetricName,
    toStartOfMinute(TimeUnix) AS minute,
    max(Value) - min(Value) AS delta
FROM otel_metrics_sum
WHERE IsMonotonic = true
  AND TimeUnix >= now() - INTERVAL 1 HOUR
GROUP BY ServiceName, MetricName, minute
ORDER BY minute ASC
FORMAT JSON
```

### Histogram percentiles

```sql
SELECT
    ServiceName,
    MetricName,
    count() AS sample_count,
    avg(Sum / Count) AS avg_value,
    min(Min) AS overall_min,
    max(Max) AS overall_max
FROM otel_metrics_histogram
WHERE TimeUnix >= now() - INTERVAL 1 HOUR
  AND Count > 0
GROUP BY ServiceName, MetricName
ORDER BY ServiceName, MetricName
FORMAT JSON
```

## Cross-signal correlation

### Find logs for a specific trace

```sql
SELECT
    Timestamp,
    SeverityText,
    ServiceName,
    Body,
    LogAttributes
FROM otel_logs
WHERE TraceId = '<trace_id>'
ORDER BY Timestamp ASC
FORMAT JSON
```

### Find traces with errors and their associated logs

```sql
SELECT
    t.TraceId,
    t.SpanName,
    t.ServiceName,
    t.StatusMessage,
    t.Duration / 1000000 AS duration_ms,
    l.Body AS log_message,
    l.SeverityText
FROM otel_traces t
LEFT JOIN otel_logs l ON t.TraceId = l.TraceId AND t.SpanId = l.SpanId
WHERE t.StatusCode = 'Error'
  AND t.Timestamp >= now() - INTERVAL 1 HOUR
ORDER BY t.Timestamp DESC
LIMIT 50
FORMAT JSON
```

## Errors

The `otel_errors` table stores extracted exception data from both logs and traces.
Errors are extracted by the worker when it detects `exception.type` or `exception.message`
attributes on log records or span events named `exception`.

### List issues (errors grouped by fingerprint)

```sql
SELECT
    FingerprintHash,
    anyLast(ExceptionType) AS last_type,
    anyLast(ExceptionMessage) AS last_message,
    anyLast(Level) AS last_level,
    count() AS event_count,
    min(Timestamp) AS first_seen,
    max(Timestamp) AS last_seen,
    countIf(MechanismHandled = false) AS unhandled_count
FROM otel_errors
WHERE Timestamp >= now() - INTERVAL 24 HOUR
GROUP BY FingerprintHash
ORDER BY last_seen DESC
LIMIT 50
FORMAT JSON
```

### List issues filtered by service

```sql
SELECT
    FingerprintHash,
    anyLast(ExceptionType) AS last_type,
    anyLast(ExceptionMessage) AS last_message,
    count() AS event_count,
    min(Timestamp) AS first_seen,
    max(Timestamp) AS last_seen,
    countIf(MechanismHandled = false) AS unhandled_count
FROM otel_errors
WHERE ServiceName = 'api-gateway'
  AND Timestamp >= now() - INTERVAL 7 DAY
GROUP BY FingerprintHash
ORDER BY event_count DESC
LIMIT 50
FORMAT JSON
```

### Recent error events for a specific issue

```sql
SELECT
    Timestamp,
    ExceptionType,
    ExceptionMessage,
    ExceptionStacktrace,
    MechanismType,
    MechanismHandled,
    Level,
    Release,
    Environment,
    TraceId,
    SpanId,
    Tags
FROM otel_errors
WHERE FingerprintHash = '<fingerprint_hash>'
ORDER BY Timestamp DESC
LIMIT 20
FORMAT JSON
```

### Unhandled errors only

```sql
SELECT
    FingerprintHash,
    anyLast(ExceptionType) AS last_type,
    anyLast(ExceptionMessage) AS last_message,
    count() AS event_count,
    max(Timestamp) AS last_seen
FROM otel_errors
WHERE MechanismHandled = false
  AND Timestamp >= now() - INTERVAL 24 HOUR
GROUP BY FingerprintHash
ORDER BY last_seen DESC
LIMIT 50
FORMAT JSON
```

### Error rate by release

```sql
SELECT
    Release,
    count() AS error_count,
    uniq(FingerprintHash) AS unique_issues,
    countIf(MechanismHandled = false) AS unhandled_count,
    min(Timestamp) AS first_error,
    max(Timestamp) AS last_error
FROM otel_errors
WHERE Timestamp >= now() - INTERVAL 7 DAY
  AND Release != ''
GROUP BY Release
ORDER BY last_error DESC
FORMAT JSON
```

### Error volume over time (timeseries)

```sql
SELECT
    toStartOfMinute(Timestamp) AS minute,
    count() AS error_count,
    uniq(FingerprintHash) AS unique_issues
FROM otel_errors
WHERE Timestamp >= now() - INTERVAL 1 HOUR
GROUP BY minute
ORDER BY minute ASC
FORMAT JSON
```

### Find error with its trace context

```sql
SELECT
    e.Timestamp,
    e.ExceptionType,
    e.ExceptionMessage,
    e.FingerprintHash,
    t.SpanName,
    t.SpanKind,
    t.Duration / 1000000 AS span_duration_ms,
    t.ServiceName
FROM otel_errors e
LEFT JOIN otel_traces t ON e.TraceId = t.TraceId AND e.SpanId = t.SpanId
WHERE e.TraceId = '<trace_id>'
ORDER BY e.Timestamp ASC
FORMAT JSON
```
