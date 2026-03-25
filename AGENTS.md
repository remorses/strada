# Strada

Open-source OpenTelemetry observability stack on top of Tinybird. Goal is to reimplement the core value of Sentry (error tracking, tracing, logs, metrics) but based on the OpenTelemetry standard instead of Sentry's proprietary bloated SDK. Users send OTEL data via standard SDKs, we store it in Tinybird, they query it with SQL.

## Architecture

- **otel-tinybird**: Cloudflare Worker (Spiceflow) that receives OTLP HTTP/JSON and forwards to Tinybird Events API as NDJSON
- **tinybird/**: Tinybird project with datasource definitions and materialized views, deployed with `tb deploy`
- **Multi-tenancy**: hostname-based tenant extraction. Each tenant gets `{tenant}-ingest.stradametrics.com`. Self-hosted users use a plain `ingest.{domain}` with empty tenant_id
- **Query layer**: Tinybird Query API (`/v0/sql`) with JWT row-level filtering, NOT the ClickHouse HTTP interface (which doesn't support JWTs or row filtering). No pipe endpoints — all queries are raw SQL

## Multi-tenancy

### How tenant_id is determined

Tenant identity comes from the **hostname**, not from API keys or headers. No KV, no DB lookup — pure hostname parsing:

```
acme-ingest.stradametrics.com       → tenant_id = "acme"
my-company-ingest.stradametrics.com → tenant_id = "my-company"
ingest.stradametrics.com            → tenant_id = ""  (shared/default)
ingest.mycompany.com                → tenant_id = ""  (self-hosted)
localhost:3000                      → tenant_id = ""  (development)
```

The regex is `^(.+)-ingest\.` — if hostname has a `{prefix}-ingest.` pattern, the prefix is the tenant_id. Otherwise empty string. This is in `otel-tinybird/src/get-tenant-id.ts`.

The `otel-tinybird` worker injects `tenant_id` into every NDJSON row before sending to Tinybird. Users never set tenant_id — the worker does it based on which subdomain they're hitting.

### Tenant isolation on reads

`TenantId` is the first column in every table's sorting key. This means ClickHouse skips all other tenants' data at the granule level on every query — effectively free filtering.

For reads, the backend generates a short-lived JWT per user session:

```json
{
  "workspace_id": "<workspace_id>",
  "name": "user_<user_id>",
  "exp": 1234567890,
  "scopes": [
    {
      "type": "DATASOURCES:READ",
      "resource": "otel_traces",
      "filter": "TenantId = 'acme'"
    },
    {
      "type": "DATASOURCES:READ",
      "resource": "otel_logs",
      "filter": "TenantId = 'acme'"
    },
    {
      "type": "DATASOURCES:READ",
      "resource": "otel_metrics_gauge",
      "filter": "TenantId = 'acme'"
    },
    {
      "type": "DATASOURCES:READ",
      "resource": "otel_metrics_sum",
      "filter": "TenantId = 'acme'"
    },
    {
      "type": "DATASOURCES:READ",
      "resource": "otel_metrics_histogram",
      "filter": "TenantId = 'acme'"
    },
    {
      "type": "DATASOURCES:READ",
      "resource": "otel_metrics_exponential_histogram",
      "filter": "TenantId = 'acme'"
    },
    {
      "type": "DATASOURCES:READ",
      "resource": "otel_errors",
      "filter": "TenantId = 'acme'"
    }
  ],
  "limits": { "rps": 10 }
}
```

The `filter` is enforced server-side by Tinybird on every query to `/v0/sql`. Users can write arbitrary SQL and the filter is always appended — no way to bypass it. The JWT is signed with the workspace admin token and can't be tampered with.

The ClickHouse HTTP interface (`clickhouse.*.tinybird.co`) does NOT support JWTs or row-level filtering. All user-facing queries must go through Tinybird's Query API (`/v0/sql`).

### ServiceName as project

Within a tenant, `ServiceName` (from the OTel `service.name` resource attribute) acts as the "project" grouping. Users filter by service in the UI to view different apps. ServiceName is the second key in all sorting keys, so per-service queries within a tenant are fast too.

## Tables

All table definitions live in `tinybird/datasources/`. Every table has `TenantId` as the first column and first in the sorting key. The `otel-tinybird` worker receives OTLP HTTP/JSON on 3 endpoints (`/v1/traces`, `/v1/logs`, `/v1/metrics`) and writes to these tables via the Tinybird Events API.

OTel defines 3 signal types — traces, logs, metrics — each with a different protobuf schema and different column shapes. Metrics further split into 4 sub-types because their value representations are incompatible (a gauge is one Float64, a histogram is arrays of bucket counts and bounds). Separate tables mean no nulls, better compression, and sorting keys optimized per signal.

### Traces — `otel_traces`

**Ingested from:** `POST /v1/traces` → `otel_traces`

A **span** is one unit of work (HTTP request, DB query, function call). Spans link via `ParentSpanId` to form a **trace** — a tree showing how a request flowed through services.

**Sorting key:** `TenantId, ServiceName, SpanName, toDateTime(Timestamp)`

**Key columns:** `TraceId`, `SpanId`, `ParentSpanId`, `SpanName`, `SpanKind` (server/client/producer/consumer), `Duration` (nanoseconds), `StatusCode` (ok/error/unset), `StatusMessage`, `SpanAttributes` (Map), `ResourceAttributes` (Map). Events (timestamped annotations within a span) and links (cross-trace references) are stored as parallel arrays.

**Indexes:** bloom filter on `TraceId` (0.001 false positive), bloom filters on attribute map keys/values, minmax on `Duration`.

**Answers:** "why was this request slow?", "which service errored?", "what's the call graph?", "show me the p95 latency for GET /users"

### Traces materialized view — `otel_traces_trace_id_ts`

**Populated by:** `otel_traces_trace_id_ts_mv` (fires automatically on every insert to `otel_traces`)

Aggregates `min(Timestamp)` and `max(Timestamp)` per `TenantId + TraceId`. Without it, answering "how long did trace X take?" requires scanning all spans. With it, it's a single row lookup.

**Sorting key:** `TenantId, TraceId, toUnixTimestamp(Start)`

### Logs — `otel_logs`

**Ingested from:** `POST /v1/logs` → `otel_logs`

A **log record** is a timestamped text message with a severity level. Optionally correlated to a trace via `TraceId`/`SpanId`.

**Sorting key:** `TenantId, ServiceName, TimestampTime, Timestamp`

**Key columns:** `SeverityText` (INFO/WARN/ERROR/FATAL), `SeverityNumber` (0-24), `Body` (the log message), `TraceId`, `SpanId` (for trace correlation), `LogAttributes` (Map), `ResourceAttributes` (Map).

**Indexes:** bloom filter on `TraceId`, `tokenbf_v1` on `Body` for full-text search, bloom filters on attribute map keys/values.

**Answers:** "what errors happened in the last hour?", "what did the app log during this trace?", "search logs containing 'timeout'"

### Gauge metrics — `otel_metrics_gauge`

**Ingested from:** `POST /v1/metrics` (when `metric.gauge` is set) → `otel_metrics_gauge`

A **gauge** is a snapshot reading at a point in time. The value can go up or down freely.

**Sorting key:** `TenantId, ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix)`

**Key columns:** `MetricName`, `Value` (Float64), `Attributes` (Map), `MetricUnit`, `MetricDescription`.

**Examples:** CPU usage (73%), memory used (2.1GB), active connections (42), queue depth (150).

### Sum metrics — `otel_metrics_sum`

**Ingested from:** `POST /v1/metrics` (when `metric.sum` is set) → `otel_metrics_sum`

A **sum** is a cumulative counter. You compute rates by diffing consecutive values over time.

**Sorting key:** same as gauge

**Key columns:** same as gauge plus `AggregationTemporality` (Int32, cumulative vs delta) and `IsMonotonic` (Bool, only goes up vs can decrease). Separate from gauge because you query them differently — gauges you take the latest value, sums you compute `max(Value) - min(Value)` over a window for a rate.

**Examples:** total requests served (1,847,293), total bytes sent (53GB), total errors (412).

### Histogram metrics — `otel_metrics_histogram`

**Ingested from:** `POST /v1/metrics` (when `metric.histogram` is set) → `otel_metrics_histogram`

A **histogram** captures the distribution of values using predefined bucket boundaries (e.g. `[5, 10, 25, 50, 100, 250, 500, 1000]` ms).

**Sorting key:** same as gauge

**Key columns:** `Count` (UInt64), `Sum` (Float64), `BucketCounts` (Array(UInt64)), `ExplicitBounds` (Array(Float64)), `Min`, `Max`, `AggregationTemporality`.

**Examples:** request latency distribution, response size distribution. Answers: "what's the p95 latency?", "what % of requests are under 100ms?"

### Exponential histogram metrics — `otel_metrics_exponential_histogram`

**Ingested from:** `POST /v1/metrics` (when `metric.exponentialHistogram` is set) → `otel_metrics_exponential_histogram`

Same idea as histogram but buckets are logarithmically spaced and auto-scale. No need to predefine boundaries — the SDK picks them based on a `scale` parameter. Better precision at the tails.

**Sorting key:** same as gauge

**Key columns:** `Count`, `Sum`, `Scale` (Int32), `ZeroCount` (UInt64), `PositiveOffset` (Int32), `PositiveBucketCounts` (Array(UInt64)), `NegativeOffset`, `NegativeBucketCounts`, `Min`, `Max`, `AggregationTemporality`.

### Shared table properties

All tables use:
- `MergeTree` engine
- Daily partitions (`toDate(Timestamp)` or `toDate(TimeUnix)`)
- Bloom filter indexes on attribute map keys/values
- `ZSTD(1)` compression on all columns, `Delta(8)` on timestamps
- `LowCardinality(String)` on low-cardinality fields (ServiceName, SpanKind, SeverityText, etc.)
- `Map(LowCardinality(String), String)` for flexible key-value attributes

### Errors — `otel_errors`

**Ingested from:** extracted by the worker from both `/v1/logs` and `/v1/traces`

The worker scans incoming data for exceptions:
- **From logs:** log records with `exception.type` or `exception.message` in `LogAttributes`
- **From traces:** span events where `name === 'exception'` (the OTel convention for recording exceptions on spans)

When an exception is detected, the worker extracts it into a denormalized error row and writes it to `otel_errors`. The original log/trace row is still written to its respective table — errors are an additional extraction, not a replacement.

**Sorting key:** `TenantId, ServiceName, FingerprintHash, toDateTime(Timestamp)`

**Key columns:** `ExceptionType`, `ExceptionMessage`, `ExceptionStacktrace` (raw string), `ExceptionFrames` (JSON string of structured frames), `Fingerprint` (Array(String)), `FingerprintHash` (hex hash for GROUP BY), `MechanismType`, `MechanismHandled`, `DebugId`, `Level`, `Release`, `Environment`, `Tags` (Map), `TraceId`, `SpanId` (for correlation back to traces/logs), `SourceSignal` (`"log"` or `"trace"`).

**No materialized view.** Issue grouping (GROUP BY FingerprintHash) is done at query time. ClickHouse handles this efficiently because FingerprintHash is in the sorting key, so rows for the same issue are physically co-located. Add a MV later only if query latency becomes a problem at scale.

**Answers:** "what are the top errors?", "is this error handled or unhandled?", "how many times did this error happen?", "which release introduced this bug?", "show me the stacktrace for this error group"

## Error tracking — custom OTel attributes

Strada extends OTel's standard `exception.*` attributes with additional error-tracking attributes. These are NOT part of the OTel semantic conventions — they are custom attributes that Strada SDKs set on OTel log records (or span event attributes) alongside the standard ones. Any OTel SDK can set them as regular string attributes.

We use the `exception.*` namespace (not a vendor prefix like `strada.*`) because these concepts are universal to error tracking, not Strada-specific. If OTel ever standardizes fingerprinting or mechanism metadata, the names would be similar.

### Standard OTel attributes (already defined by OTel spec)

| Attribute | Type | Description |
|-----------|------|-------------|
| `exception.type` | string | Fully-qualified exception class name. e.g. `"TypeError"`, `"java.net.ConnectException"` |
| `exception.message` | string | The exception message string |
| `exception.stacktrace` | string | Raw stacktrace as a string in the language's natural format |

### Standard OTel resource attributes (set on the SDK's Resource, not per-event)

| Attribute | Type | Maps to |
|-----------|------|---------|
| `service.version` | string | Release / app version. Stored as `Release` column |
| `deployment.environment.name` | string | Environment (`"production"`, `"staging"`). Stored as `Environment` column |

### Custom error-tracking attributes (set by Strada SDKs)

| Attribute | Type | Description |
|-----------|------|-------------|
| `exception.fingerprint` | string (JSON array) | Custom fingerprint override for grouping. e.g. `'["db-timeout","users-service"]'`. When absent, the worker computes a default fingerprint from exception type + top in-app frame function + stripped message |
| `exception.mechanism.type` | string | How the exception was captured: `"generic"` (user-called captureException), `"onerror"` (window.onerror), `"unhandledrejection"` (promise rejection), `"uncaughtException"` (Node.js process), etc. |
| `exception.mechanism.handled` | string | `"true"` if user code caught it (try/catch + captureException), `"false"` if caught by a global handler. OTel attributes are strings, so this is `"true"`/`"false"` not boolean |
| `exception.structured_frames` | string (JSON array) | Parsed stack frames. Each frame: `{"filename": "app.js", "function": "processOrder", "lineno": 42, "colno": 15, "abs_path": "/src/app.js", "in_app": true, "debug_id": "85314830-..."}`. When absent, the worker falls back to the raw `exception.stacktrace` string |
| `exception.debug_id` | string | UUID linking the source file to its source map (TC39 debug-id proposal). Used for server-side stack trace desymbolication |

### Default fingerprint computation (server-side, in the worker)

When `exception.fingerprint` is not set by the SDK, the worker computes a default:

1. If `exception.structured_frames` has frames with `in_app: true` → hash `[exception.type, top_in_app_frame.function]`
2. If no structured frames → hash `[exception.type, stripped_message]` where stripped_message has numbers, hex strings, and UUIDs replaced with `<N>`, `<hex>`, `<uuid>` to group messages that differ only in dynamic values
3. If neither type nor message → hash `["unknown"]`

The hash is a SHA-256 hex string truncated to 32 characters, stored as `FingerprintHash`.

### How errors flow through the system

```
SDK: captureException(err)
  |
  v
OTel Logger.emit({
  severityNumber: 17,  // ERROR
  attributes: {
    "exception.type": "TypeError",
    "exception.message": "Cannot read property 'foo' of null",
    "exception.stacktrace": "TypeError: Cannot read...\n  at ...",
    "exception.mechanism.type": "onerror",
    "exception.mechanism.handled": "false",
    "exception.structured_frames": "[{...}]",
  }
})
  |
  v  OTLP HTTP/JSON POST /v1/logs
  |
  v
Worker:
  1. transformLogs() → writes to otel_logs (unchanged)
  2. extractErrorsFromLogs() → detects exception.type in attributes
     → parses custom attributes
     → computes fingerprint
     → writes to otel_errors
```

For traces, the same extraction happens when span events named `exception` are found:

```
SDK: span.recordException(err)
  |
  v  OTLP HTTP/JSON POST /v1/traces
  |
  v
Worker:
  1. transformTraces() → writes to otel_traces (unchanged)
  2. extractErrorsFromTraces() → scans events_name for "exception"
     → extracts exception.* from event attributes
     → computes fingerprint
     → writes to otel_errors
```

## Testing

Run tests with `vitest run` (not `vitest` which starts watch mode and never exits):

```bash
pnpm vitest run                           # all tests
pnpm vitest run src/extract-errors.test.ts # single file
```

## Reference schema

The Tinybird OTel template (https://github.com/tinybirdco/tinybird-otel-template) is the base inspiration for our OTel schema and SQL query examples. Our `tinybird/datasources/` files are derived from it with multi-tenancy additions. Use it as reference for column names, types, indexes, sorting keys, and example queries against OTel data in ClickHouse.

## Tinybird

We target **Tinybird Forward** (the new CLI-based experience), not Classic. Forward is the actively developed version.

**Classic vs Forward differences that matter to us:**
- Forward dropped `sql_filter` on static tokens. Use JWT `filter` instead
- Forward JWTs support `DATASOURCES:READ` scope with `filter` field (Classic JWTs only had `PIPES:READ`)
- Forward uses `tb deploy` instead of `tb push`

### Tinybird docs

- Concepts: https://www.tinybird.co/docs/forward/get-started/concepts
- Architecture: https://www.tinybird.co/docs/forward/get-started/architecture
- Data sources: https://www.tinybird.co/docs/forward/get-data-in/data-sources
- Events API (ingestion): https://www.tinybird.co/docs/forward/get-data-in/events-api
- Pipes: https://www.tinybird.co/docs/forward/work-with-data/pipes
- Endpoints: https://www.tinybird.co/docs/forward/work-with-data/publish-data/endpoints
- Materialized views: https://www.tinybird.co/docs/forward/work-with-data/optimize/materialized-views
- Query API (arbitrary SQL): https://www.tinybird.co/docs/api-reference/query-api
- Tokens overview: https://www.tinybird.co/docs/forward/administration/tokens
- Static tokens: https://www.tinybird.co/docs/forward/administration/tokens/static-tokens
- JWTs: https://www.tinybird.co/docs/forward/administration/tokens/jwt
- ClickHouse interface (read-only, no JWT support): https://www.tinybird.co/docs/forward/work-with-data/publish-data/clickhouse-interface
- SQL reference: https://www.tinybird.co/docs/sql-reference
- Datasource files: https://www.tinybird.co/docs/forward/dev-reference/datafiles/datasource-files
- Pipe files: https://www.tinybird.co/docs/forward/dev-reference/datafiles/pipe-files
- CLI commands: https://www.tinybird.co/docs/forward/dev-reference/commands
- Limits: https://www.tinybird.co/docs/forward/pricing/limits
- Local dev: https://www.tinybird.co/docs/forward/test-and-deploy/local
- Deployments: https://www.tinybird.co/docs/forward/test-and-deploy/deployments
- Template functions: https://www.tinybird.co/docs/forward/dev-reference/template-functions
- Multi-tenant guide with Clerk: https://www.tinybird.co/docs/forward/work-with-data/publish-data/guides/multitenant-real-time-apis-with-clerk-and-tinybird
