# Strada

this project is still unreleased. ignore backwards compatibility. instead strive to make code and architecture simple and elegant, discarding backwards compatibility

This repo uses **pnpm** as its package manager. Always use `pnpm` (not bun/npm/yarn) for install, run, and publish commands.

Open-source OpenTelemetry observability platform. Reimplements the core value of Sentry (error tracking, tracing, logs, metrics) based on the OpenTelemetry standard instead of proprietary bloated SDKs. Users send OTel data via standard SDKs, Strada stores it in their ClickHouse database (Tinybird as first-class support), and they query it with SQL.

Each user gets their own ClickHouse database. There are no shared tenants. Within a database, data is partitioned by **project** (`ProjectId`). A user can have multiple projects (e.g. "frontend", "api", "worker") each sending data to their own ingest endpoint. Projects get scoped tokens for security.

Strada is a Cloudflare-based infrastructure that wraps the user's database and handles: authentication, team invites, ingestion, a UI for browsing logs/errors/spans, email alerts, token generation, and a CLI to query the data.

We use the standard OTel schema for ClickHouse: https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/clickhouseexporter/internal/sqltemplates/logs_json_table.sql

See other files in sqltemplates as well for other kinds of tables.

## npm packages

all publishable packages in this repo should have name `strada` (the main cli, cli folder) or be under the `@strada.sh` scope. 

## CLI conventions (goke)

The CLI uses [goke](https://github.com/remorses/goke) as the command framework. Load the `goke` skill before writing CLI commands.

**Repeatable options instead of comma-separated values.** Never accept comma-separated strings for multi-value options. Use `z.array(z.string())` from zod so the user passes the flag multiple times:

```ts
import { z } from "zod";

cli
  .command("issues list", "List issue groups")
  .option("-p, --project <slug>", z.array(z.string()).describe("Project slug (repeatable)"))
  .action((options) => {
    // options.project is string[]
    // Usage: strada issues list -p frontend -p api -p worker
  });
```

Never do `options.project.split(",")`. The user passes `-p frontend -p api` instead of `-p frontend,api`.

## Spiceflow version

All packages that depend on `spiceflow` must use the **exact same version**. The typed fetch client passes the `App` type as a generic, and mismatched versions cause `Types have separate declarations of a private property` errors because TypeScript sees two different `Spiceflow` class declarations.

Always use the `@rsc` tag. To sync all packages to the same version:

```bash
pnpm update -r spiceflow
```

Do not pass `--latest`; `pnpm update` without it respects the existing version range and resolves to the highest matching version across all packages.

## Deployments

**Always deploy preview first, then production.** Never go straight to production.

```bash
# 1. Deploy preview (runs migration + build + deploy)
pnpm --dir website deploy
pnpm --dir otel-collector deploy

# 2. Verify preview works (load the page, check /api/health, test ingest)

# 3. Deploy production (runs migration + build + deploy)
pnpm --dir website deploy:prod
pnpm --dir otel-collector deploy:prod
```

If the preview migration or deploy fails, **stop**. Do not continue to production.

The website `deploy` and `deploy:prod` scripts run the D1 migration before building and deploying. If migration fails, the `&&` chain stops and the deploy never happens.

## Architecture

Four packages in a pnpm monorepo, sharing a single D1 database:

- **db/** — Drizzle schema and D1 migrations. Owns all table definitions (BetterAuth core, orgs, projects, database config, tokens). Used by both website and collector.
- **website/** — Cloudflare Worker (Spiceflow + BetterAuth). Handles auth (Google social login, device flow for CLI), org/project management API, database config storage, and query bridge to Tinybird/ClickHouse. The control plane.
- **otel-collector/** — Cloudflare Worker (Spiceflow). Receives OTLP HTTP/JSON and forwards to Tinybird or ClickHouse as NDJSON. Shares the D1 binding with the website to resolve project config at ingest time. No env vars for credentials; everything comes from D1.
- **cli/** — CLI tool (`strada`). Authenticates via device flow, manages projects, runs queries through the website API. Uses spiceflow typed fetch client with the website App type.
- **sdk/** — OTel-first SDK for Node.js and browser.
- **tinybird/** — Tinybird datasource definitions and materialized views, deployed with `tb deploy` via the CLI database create command.

## Website multi-tenant security

`website/` is **multi-tenant**. Treat every org, project, database config, token, and query result as tenant-scoped.

- Never leak another org's database credentials, project tokens, Tinybird JWTs, ClickHouse config, or query results.
- Never return tenant resource existence to users outside that org. Prefer tenant-scoped lookups that return not found.
- Membership is not enough for dangerous mutations. Database config changes, migrations, and token/project destructive actions should require org admin access.
- Query paths must enforce at least **org-scoped** reads at the backend layer. Use **project-scoped** enforcement when the backend supports it, like Tinybird JWT filters.

### Project visibility within an org

Projects are **not** tenant boundaries inside the `website/` app. The tenant boundary is the **org**.

- Users in the same org can read data from other projects in that same org.
- `ProjectId` is mainly an ingest and query-scoping primitive for storage/layout, not a website-level tenant boundary.
- Do not treat cross-project reads within the same org as a security leak.
- The security boundary is cross-**org**, not cross-project.

### Data flow

```
SDK (OTLP HTTP/JSON)
  |
  | POST {projectId}-ingest.strada.sh/v1/traces
  v
otel-collector
  |
  | 1. Extract projectId from hostname
  | 2. Query D1: project + database JOIN
  | 3. Create backend (Tinybird or ClickHouse)
  | 4. Transform OTLP → NDJSON
  v
Tinybird Events API  or  ClickHouse HTTP Interface
```

### Backend selection

Each org has one database config row storing either Tinybird or ClickHouse credentials. The CLI `database create` command deploys Tinybird resources and saves tokens to the database. The collector reads these credentials from D1 at ingest time.

When using ClickHouse backend, the collector remaps NDJSON keys from snake_case to PascalCase (the OTel ClickHouse standard) before INSERT. The field mapping logic lives in `otel-collector/src/field-mapping.ts`.

The ClickHouse schema (`clickhouse.sql`) has `ProjectId` as the first column in every table and first in every sorting key, matching the Tinybird schema.

### Project isolation

Project identity comes from the **hostname**: `{projectId}-ingest.strada.sh`. The project ID is a ULID from the `project` table in D1, globally unique. The collector extracts it with a regex in `get-project-id.ts`, then queries D1 for the project's database credentials. Unknown project IDs are rejected with 404.

### D1 database (shared)

Both the website and otel-collector workers bind to the same D1 database (`strada-db`). The website uses drizzle-orm/d1 for full ORM access. The collector uses raw D1 SQL (no drizzle dependency) for lightweight config resolution.

### Config resolution in the collector

The collector uses `import { env } from 'cloudflare:workers'` for the D1 binding. On each request it resolves project config with a single SQL JOIN query (`resolve-config.ts`). No env vars for Tinybird/ClickHouse credentials.

### Column naming convention

Column names follow the **standard OTel ClickHouse exporter schema** (PascalCase): `TraceId`, `SpanId`, `ServiceName`, `ResourceAttributes`, etc. This is NOT a Tinybird-specific convention. It comes from the official OTel collector-contrib ClickHouse exporter at https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/clickhouseexporter/internal/sqltemplates.

The only Strada addition is `ProjectId` as the first column in every table for project isolation. Both the Tinybird datasources and self-hosted ClickHouse schema (`clickhouse.sql`) include this column.

## SDK (`@strada.sh/sdk`)

The SDK lives in `sdk/` and is the main package users install. It is **OTel-first**: after `initStrada()`, the global OTel providers are registered and users can use standard OTel APIs (`trace.getTracer()`, `logs.getLogger()`, `metrics.getMeter()`) directly. The SDK re-exports these from `@opentelemetry/api` so users don't need to install it separately.

### Design principle

The SDK is a **configuration and convenience layer**, not a replacement for OTel. It:

1. Configures OTel providers, exporters, and processors for the Strada endpoint
2. Installs global error handlers (uncaughtException, unhandledrejection, window.error)
3. Provides convenience helpers (`captureException`, `track`, `setTags`)
4. Injects Strada-specific context (session.id, url.*, user.id) into every span and log

Users migrating from raw OTel code only need to replace their provider setup with `initStrada()`. Their existing `tracer.startSpan()`, `logger.emit()`, `meter.createCounter()` code works unchanged.

### Re-exported OTel APIs

These are re-exported from all entry points (`@strada.sh/sdk`, `@strada.sh/sdk/node`, `@strada.sh/sdk/browser`):

| Export | From | Purpose |
|--------|------|---------|
| `trace` | `@opentelemetry/api` | `trace.getTracer()` to create spans |
| `context` | `@opentelemetry/api` | Context propagation |
| `metrics` | `@opentelemetry/api` | `metrics.getMeter()` for counters, histograms |
| `propagation` | `@opentelemetry/api` | Trace context propagation |
| `diag` | `@opentelemetry/api` | OTel diagnostic logging |
| `logs` | `@opentelemetry/api-logs` | `logs.getLogger()` for log records |
| `SpanStatusCode` | `@opentelemetry/api` | Span status enum (OK, ERROR, UNSET) |
| `SpanKind` | `@opentelemetry/api` | Span kind enum (SERVER, CLIENT, etc.) |
| `SeverityNumber` | `@opentelemetry/api-logs` | Log severity enum (INFO, ERROR, etc.) |

Plus types: `Tracer`, `Span`, `SpanContext`, `SpanOptions`, `SpanAttributes`, `Logger`.

### Convenience helpers (optional sugar)

These are thin wrappers over OTel APIs with Strada conventions baked in:

| Helper | What it does under the hood |
|--------|----------------------------|
| `captureException(error, opts?)` | Normalizes the error, applies filtering (ignoreErrors/denyUrls/beforeSend), builds `exception.*` attributes, emits an OTel log record |
| `track(name, props?)` | Emits an OTel log record with `event.name` and `custom.*` attributes, correlated to active pageview span (browser only) |
| `setTags({ key: value })` | Sets tags merged into subsequent error attributes |

### Conditional exports

| Import path | Resolves to | When |
|-------------|-------------|------|
| `@strada.sh/sdk` | `node.ts` | Default (Node.js, Bun, Deno) |
| `@strada.sh/sdk` | `browser.ts` | When bundler sees `"browser"` condition |
| `@strada.sh/sdk/node` | `node.ts` | Explicit Node import |
| `@strada.sh/sdk/browser` | `browser.ts` | Explicit browser import |

### Browser-specific features

The browser entry (`sdk/src/browser.ts`) adds analytics capabilities on top of error tracking:

**Session management.** A per-tab UUID stored in `sessionStorage` under the key `strada.session_id`. Survives page refreshes, new on tab close. Injected as `session.id` into every span and log record.

**Browser detection.** Inline detection (no external package) of `browser.platform`, `browser.brands`, `browser.mobile`, `browser.language`, `user_agent.original` from `navigator.userAgentData` and `navigator.userAgent`. Set as resource attributes.

**StradaSpanProcessor.** Custom SpanProcessor that injects into every span on `onStart`:

| Attribute | Source |
|-----------|--------|
| `session.id` | sessionStorage UUID |
| `url.path` | `window.location.pathname` |
| `url.query` | `window.location.search` |
| `url.full` | `window.location.href` |
| `http.request.header.referer` | `document.referrer` |
| `user.id` | From `strada_uid` cookie or `StradaOptions.userId` |

**ContextLogProcessor.** Wraps the log processor chain and injects `session.id`, `url.path`, `url.full`, `user.id` into every log record.

**FilteringLogProcessor.** Drops known browser noise at the processor level: Script error, ResizeObserver loop, chrome/moz/safari-extension URLs.

**Pageview span lifecycle.** `startPageSpan(path?)` / `endCurrentPageSpan()` create spans with `SpanName = 'pageview'`. First pageview starts on `initStrada()`, ends on `visibilitychange: hidden`. SPA router plugins call these on navigation.

**track() API.** Custom events as OTel log records with `event.name` attribute and `custom.*` prefixed properties. Correlated to the active pageview span via OTel context propagation (TraceId/SpanId set automatically).

### Node-specific features

The Node entry (`sdk/src/node.ts`) wraps `@opentelemetry/sdk-node`:

- Configures OTLP HTTP exporters for traces, logs, and metrics
- Configures W3C Baggage extraction via `BaggageSpanProcessor` and `BaggageLogProcessor`
- Installs `process.on('uncaughtException')` and `process.on('unhandledRejection')`
- Flushes and exits on fatal errors
- Graceful shutdown on SIGTERM/SIGINT
- Auto-instrumentation via `@opentelemetry/auto-instrumentations-node` (optional peer dep, loaded via dynamic import)

### Browser-to-server context propagation (W3C Baggage)

The SDK propagates `session.id` and `user.id` from the browser to the backend using **W3C Baggage**. This is a standard OTel mechanism that carries key-value pairs in a `baggage` HTTP header alongside `traceparent`.

**Browser side:** The `PageviewContextManager` injects a Baggage object containing `strada.session.id` and `user.id` into the active OTel context. A `CompositePropagator` with `W3CTraceContextPropagator` + `W3CBaggagePropagator` serializes both headers on every outgoing `fetch`/`XHR`.

**Node side:** `BaggageSpanProcessor` reads the baggage from the incoming request context and sets `session.id` and `user.id` as span attributes. `BaggageLogProcessor` does the same for log records. This happens automatically for every backend span/log within a browser-initiated request.

**Result:** Backend spans and logs carry the same `session.id` and `user.id` as browser telemetry. No app code needed. The data lands in the same ClickHouse attribute maps (`SpanAttributes`, `LogAttributes`), so existing SQL queries that filter by `session.id` or `user.id` automatically return both browser and backend rows. `ServiceName` distinguishes the origin.

```
Browser request (session.id = abc, user.id = user_123)
  |
  | headers: traceparent: ..., baggage: strada.session.id=abc,user.id=user_123
  |
  v
Backend (BaggageSpanProcessor + BaggageLogProcessor extract from baggage)
  +-- span: POST /api/checkout     -> session.id=abc, user.id=user_123
  +-- log: "purchase" event        -> session.id=abc, user.id=user_123
```

**Baggage key names:** `strada.session.id` and `user.id`. Constants are in `shared.ts` as `BAGGAGE_SESSION_ID` and `BAGGAGE_USER_ID`.

**No SQL changes needed.** Baggage is only a transport mechanism. Once extracted, the values become regular span/log attributes stored in the same Map columns, indexed by the same bloom filters.

### Optional peer dependencies

| Package | What it adds | Loaded via |
|---------|-------------|------------|
| `@opentelemetry/auto-instrumentations-node` | Auto-instrument http, express, pg, mysql, redis, etc. | `import()` in node.ts |
| `@opentelemetry/auto-instrumentations-web` | Auto-instrument fetch, XHR, document load, user interaction | `import()` in browser.ts |

Both are loaded with dynamic `import()` so the package stays ESM-clean and works without them installed.

## Project isolation

### How project_id is determined

Project identity comes from the **hostname**. The project ID is a ULID from the `project` table in D1, globally unique across all orgs.

```
01JTHG5M7XPQR8KNCZ0W4D-ingest.strada.sh  → project_id = "01JTHG5M7XPQR8KNCZ0W4D"
```

The regex is `^(.+)-ingest\.`. If hostname has a `{prefix}-ingest.` pattern, the prefix is the project_id. Empty string means no project (rejected with 400). This is in `otel-collector/src/get-project-id.ts`.

The collector then queries D1 to validate the project exists and get database credentials. Unknown project IDs are rejected with 404. The collector injects `project_id` into every NDJSON row before sending to Tinybird/ClickHouse.

### Project isolation on reads

`ProjectId` is the first column in every table's sorting key. This means ClickHouse skips all other projects' data at the granule level on every query. Effectively free filtering.

For Tinybird reads, the website generates a **per-project JWT** with `DATASOURCES:READ` scopes filtered to `ProjectId = '<id>'` on every datasource. The JWT is cached in the `project` table (`tinybirdJwt` + `tinybirdJwtExpiresAt` columns) and regenerated when it expires (24h TTL, 5min early renewal buffer).

**How it works:** On the first query for a project, `getOrCreateProjectJwt()` in `website/src/db.ts` calls the Tinybird Token API (`POST /v0/tokens?name=...&expiration_time=...`) with the org's admin token to create a JWT. The JWT has one scope per datasource, each with `filter: "ProjectId = '<projectId>'"`. Tinybird enforces these filters server-side on every query. The JWT is then cached in D1 so subsequent queries skip the Token API call.

The list of datasources is defined in `TINYBIRD_DATASOURCES` in `cli/src/tinybird.ts`. When adding a new datasource, add it to this array so new JWTs include it.

**All SQL queries must ignore `ProjectId` completely.** `ProjectId` exists only for auth. Tinybird's JWT filter handles it automatically on every query. Never add `WHERE ProjectId = '...'` in application SQL, UI queries, or example queries. If a query uses `SELECT *`, the column will appear in results but it carries no semantic meaning for the application. It's purely an infrastructure concern for row-level isolation.

The ClickHouse HTTP interface (`clickhouse.*.tinybird.co`) does NOT support JWTs or row-level filtering. All user-facing queries must go through Tinybird's Query API (`/v0/sql`).

### ServiceName within a project

Within a project, `ServiceName` (from the OTel `service.name` resource attribute) identifies different services or apps. Users filter by service in the UI to view different parts of their system. ServiceName is the second key in all sorting keys, so per-service queries within a project are fast.

## Tables

All table definitions live in `tinybird/datasources/`. Every table has `ProjectId` as the first column and first in the sorting key. The `otel-collector` worker receives OTLP HTTP/JSON on 3 endpoints (`/v1/traces`, `/v1/logs`, `/v1/metrics`) and writes to these tables via the Tinybird Events API.

OTel defines 3 signal types, traces, logs, metrics, each with a different protobuf schema and different column shapes. Metrics further split into 4 sub-types because their value representations are incompatible (a gauge is one Float64, a histogram is arrays of bucket counts and bounds). Separate tables mean no nulls, better compression, and sorting keys optimized per signal.

### Traces — `otel_traces`

**Ingested from:** `POST /v1/traces` → `otel_traces`

A **span** is one unit of work (HTTP request, DB query, function call). Spans link via `ParentSpanId` to form a **trace**, a tree showing how a request flowed through services.

**Sorting key:** `ProjectId, ServiceName, SpanName, toDateTime(Timestamp)`

**Key columns:** `TraceId`, `SpanId`, `ParentSpanId`, `SpanName`, `SpanKind` (server/client/producer/consumer), `Duration` (nanoseconds), `StatusCode` (ok/error/unset), `StatusMessage`, `SpanAttributes` (Map), `ResourceAttributes` (Map). Events (timestamped annotations within a span) and links (cross-trace references) are stored as parallel arrays.

**Indexes:** bloom filter on `TraceId` (0.001 false positive), bloom filters on attribute map keys/values, minmax on `Duration`.

**Answers:** "why was this request slow?", "which service errored?", "what's the call graph?", "show me the p95 latency for GET /users"

### Traces materialized view — `otel_traces_trace_id_ts`

**Populated by:** `otel_traces_trace_id_ts_mv` (fires automatically on every insert to `otel_traces`)

Aggregates `minState(Timestamp)` and `maxState(Timestamp)` per `ProjectId + TraceId` using `AggregatingMergeTree`. Without it, answering "how long did trace X take?" requires scanning all spans. With it, it's a single grouped lookup. Read with `minMerge(Start)` / `maxMerge(End)` and `GROUP BY TraceId`.

**Sorting key:** `ProjectId, TraceId`

**Key columns:** `Start` (`AggregateFunction(min, DateTime64(9))`), `End` (`AggregateFunction(max, DateTime64(9))`)

### Browser analytics pages — `otel_analytics_pages`

**Populated by:** `otel_analytics_pages_mv` from `otel_traces` pageview spans only.

Pre-aggregated pageview analytics by domain, pathname, referrer, device, browser, country, and language. Powers top pages, top browsers, countries, referrers, and pageview/visitor timeseries without scanning raw traces.

**Sorting key:** `ProjectId, ServiceName, Domain, Date, Device, Browser, Country, Language, Pathname, Referrer`

**Key columns:** `Date`, `Domain`, `Pathname`, `Referrer`, `Device`, `Browser`, `Country`, `Language`, `Visits` (`uniqState(session.id)`), `Hits` (`countState()`).

### Browser analytics sessions — `otel_analytics_sessions`

**Populated by:** `otel_analytics_sessions_mv` from `otel_traces` pageview spans only.

Pre-aggregated per-session rows for bounce rate, average session duration, and unique visitor calculations.

**Sorting key:** `ProjectId, ServiceName, Domain, Date, SessionId`

**Key columns:** `SessionId`, `Device`, `Browser`, `Country`, `FirstHit`, `LatestHit`, `Hits`.

### Logs — `otel_logs`

**Ingested from:** `POST /v1/logs` → `otel_logs`

A **log record** is a timestamped text message with a severity level. Optionally correlated to a trace via `TraceId`/`SpanId`.

**Sorting key:** `ProjectId, ServiceName, TimestampTime, Timestamp`

**Key columns:** `SeverityText` (INFO/WARN/ERROR/FATAL), `SeverityNumber` (0-24), `Body` (the log message), `TraceId`, `SpanId` (for trace correlation), `LogAttributes` (Map), `ResourceAttributes` (Map).

**Indexes:** bloom filter on `TraceId`, `tokenbf_v1` on `Body` for full-text search, bloom filters on attribute map keys/values.

**Answers:** "what errors happened in the last hour?", "what did the app log during this trace?", "search logs containing 'timeout'"

### Gauge metrics — `otel_metrics_gauge`

**Ingested from:** `POST /v1/metrics` (when `metric.gauge` is set) → `otel_metrics_gauge`

A **gauge** is a snapshot reading at a point in time. The value can go up or down freely.

**Sorting key:** `ProjectId, ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix)`

**Key columns:** `MetricName`, `Value` (Float64), `Attributes` (Map), `MetricUnit`, `MetricDescription`.

**Examples:** CPU usage (73%), memory used (2.1GB), active connections (42), queue depth (150).

### Sum metrics — `otel_metrics_sum`

**Ingested from:** `POST /v1/metrics` (when `metric.sum` is set) → `otel_metrics_sum`

A **sum** is a cumulative counter. You compute rates by diffing consecutive values over time.

**Sorting key:** same as gauge

**Key columns:** same as gauge plus `AggregationTemporality` (Int32, cumulative vs delta) and `IsMonotonic` (Bool, only goes up vs can decrease). Separate from gauge because you query them differently. Gauges you take the latest value, sums you compute `max(Value) - min(Value)` over a window for a rate.

**Examples:** total requests served (1,847,293), total bytes sent (53GB), total errors (412).

### Histogram metrics — `otel_metrics_histogram`

**Ingested from:** `POST /v1/metrics` (when `metric.histogram` is set) → `otel_metrics_histogram`

A **histogram** captures the distribution of values using predefined bucket boundaries (e.g. `[5, 10, 25, 50, 100, 250, 500, 1000]` ms).

**Sorting key:** same as gauge

**Key columns:** `Count` (UInt64), `Sum` (Float64), `BucketCounts` (Array(UInt64)), `ExplicitBounds` (Array(Float64)), `Min`, `Max`, `AggregationTemporality`.

**Examples:** request latency distribution, response size distribution. Answers: "what's the p95 latency?", "what % of requests are under 100ms?"

### Exponential histogram metrics — `otel_metrics_exponential_histogram`

**Ingested from:** `POST /v1/metrics` (when `metric.exponentialHistogram` is set) → `otel_metrics_exponential_histogram`

Same idea as histogram but buckets are logarithmically spaced and auto-scale. No need to predefine boundaries. The SDK picks them based on a `scale` parameter. Better precision at the tails.

**Sorting key:** same as gauge

**Key columns:** `Count`, `Sum`, `Scale` (Int32), `ZeroCount` (UInt64), `PositiveOffset` (Int32), `PositiveBucketCounts` (Array(UInt64)), `NegativeOffset`, `NegativeBucketCounts`, `Min`, `Max`, `AggregationTemporality`.

### Shared table properties

Raw OTel signal tables use:

- `MergeTree` engine
- Daily partitions (`toDate(Timestamp)` or `toDate(TimeUnix)`)
- Bloom filter indexes on attribute map keys/values
- `ZSTD(1)` compression on all columns, `Delta(8)` on timestamps
- `LowCardinality(String)` on low-cardinality fields (ServiceName, SpanKind, SeverityText, etc.)
- `Map(LowCardinality(String), String)` for flexible key-value attributes

Analytics aggregate tables use:

- `AggregatingMergeTree`
- Daily partitions by `Date`
- 90-day TTL independent from raw trace retention

### Errors — `otel_errors`

**Ingested from:** extracted by the worker from both `/v1/logs` and `/v1/traces`

The worker scans incoming data for exceptions:

- **From logs:** log records with `exception.type` or `exception.message` in `LogAttributes`
- **From traces:** span events where `name === 'exception'` (the OTel convention for recording exceptions on spans)

When an exception is detected, the worker extracts it into a denormalized error row and writes it to `otel_errors`. The original log/trace row is still written to its respective table. Errors are an additional extraction, not a replacement.

**Sorting key:** `ProjectId, ServiceName, FingerprintHash, toDateTime(Timestamp)`

**Key columns:** `ExceptionType`, `ExceptionMessage`, `ExceptionStacktrace` (raw string), `ExceptionFrames` (JSON string of structured frames), `Fingerprint` (Array(String)), `FingerprintHash` (hex hash for GROUP BY), `MechanismType`, `MechanismHandled`, `DebugId`, `Level`, `Release`, `Environment`, `Tags` (Map), `TraceId`, `SpanId` (for correlation back to traces/logs), `SourceSignal` (`"log"` or `"trace"`).

**No materialized view.** Issue grouping (GROUP BY FingerprintHash) is done at query time. ClickHouse handles this efficiently because FingerprintHash is in the sorting key, so rows for the same issue are physically co-located. Add a MV later only if query latency becomes a problem at scale.

**Answers:** "what are the top errors?", "is this error handled or unhandled?", "how many times did this error happen?", "which release introduced this bug?", "show me the stacktrace for this error group"

## SDK custom attributes and event conventions

Strada extends plain OpenTelemetry with a small set of **nonstandard but important conventions**. These are a superset of OTel, not a replacement for it. They let the SDK model error tracking, browser analytics, session context, and custom product events without inventing a separate transport or schema.

The rule is simple:

- keep using standard OTel APIs and standard semantic attributes where they already exist
- add a few **custom attributes** only when OTel does not standardize the concept yet
- keep those attributes stable so they can be queried directly from SQL later
- **always use `ATTR.*` constants** from `sdk/src/shared.ts` instead of raw strings. Never write `"session.id"` or `"service.name"` directly; use `ATTR.SESSION_ID` or `ATTR.SERVICE_NAME`. This prevents typos, makes renaming safe, and keeps all attribute names discoverable in one place. If a new attribute is needed, add it to the `ATTR` object first.

Any OTel SDK can set these as normal string attributes on spans, span events, or log records.

### Why these conventions exist

| Convention | Why Strada adds it |
| ---------- | ------------------ |
| `exception.*` extensions | OTel gives us the basics of exceptions, but not issue fingerprinting, capture mechanism metadata, or source-map oriented structured frames |
| `event.name` + `custom.*` | OTel logs are flexible, but product analytics events need a stable way to distinguish events from ordinary logs and store event-specific properties |
| `session.id` | Browser analytics and user journeys need a stable per-tab session key that survives page refreshes without forcing one giant browser trace |
| `url.path`, `url.query`, `url.full`, `http.request.header.referer` on browser telemetry | These make page, funnel, and session analysis easy without requiring each app to add the attributes manually |
| `user.id` on spans and logs | Correlates traces, logs, errors, and analytics events to the same signed-in user across browser and backend |

### Standard OTel attributes we rely on

| Attribute              | Type   | Description                                                                             |
| ---------------------- | ------ | --------------------------------------------------------------------------------------- |
| `exception.type`       | string | Fully-qualified exception class name. e.g. `"TypeError"`, `"java.net.ConnectException"` |
| `exception.message`    | string | The exception message string                                                            |
| `exception.stacktrace` | string | Raw stacktrace as a string in the language's natural format                             |

### Standard OTel resource attributes (set on the SDK's Resource, not per-event)

| Attribute                     | Type   | Maps to                                                                   |
| ----------------------------- | ------ | ------------------------------------------------------------------------- |
| `service.version`             | string | Release / app version. Stored as `Release` column                         |
| `deployment.environment.name` | string | Environment (`"production"`, `"staging"`). Stored as `Environment` column |

### Custom event convention (set by Strada SDKs)

Custom product events are stored as **OTel log records**, not spans. They live in `otel_logs` next to ordinary logs, so Strada needs a stable way to tell them apart later when running SQL.

| Attribute | Type | Description |
| --------- | ---- | ----------- |
| `event.name` | string | Structured event name. Presence of this key means the log record is a custom event, not an ordinary application log. Example: `"signup_started"`, `"purchase"` |
| `custom.*` | string / number / boolean | Event-specific properties namespaced under `custom.` so they don't collide with OTel semantic attributes. Example: `custom.plan = "pro"`, `custom.source = "hero"` |

This is how browser and backend custom events are queryable later with SQL while ignoring normal logs:

```sql
SELECT Timestamp, ServiceName, LogAttributes['event.name'] AS event_name
FROM otel_logs
WHERE mapContains(LogAttributes, 'event.name')
ORDER BY Timestamp DESC
LIMIT 100
```

### Browser/session context attributes (set by the browser SDK)

These are injected into browser spans and log records so analytics, custom events, and errors can be grouped by visit, page, and user without app code needing to add them on every call.

| Attribute | Type | Description |
| --------- | ---- | ----------- |
| `session.id` | string | Stable per-tab UUID stored in `sessionStorage`. Groups multiple pageview traces into one browser session without forcing one giant trace |
| `url.path` | string | Current `window.location.pathname` |
| `url.query` | string | Current `window.location.search` |
| `url.full` | string | Current `window.location.href` |
| `http.request.header.referer` | string | `document.referrer`, useful for entry page and attribution analysis |
| `user.id` | string | Signed-in user identity from `strada_uid` cookie / `StradaOptions.userId`, injected into browser spans and logs and often mirrored on backend logs/spans too |

### Custom error-tracking attributes (set by Strada SDKs)

We use the `exception.*` namespace, not a vendor prefix like `strada.*`, because these concepts are universal to error tracking even though OTel has not standardized all of them yet.

| Attribute                     | Type                | Description                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exception.fingerprint`       | string (JSON array) | Custom fingerprint override for grouping. e.g. `'["db-timeout","users-service"]'`. When absent, the worker computes a default fingerprint from exception type + top in-app frame function + stripped message                                                         |
| `exception.mechanism.type`    | string              | How the exception was captured: `"generic"` (user-called captureException), `"onerror"` (window.onerror), `"unhandledrejection"` (promise rejection), `"uncaughtException"` (Node.js process), etc.                                                                  |
| `exception.mechanism.handled` | string              | `"true"` if user code caught it (try/catch + captureException), `"false"` if caught by a global handler. OTel attributes are strings, so this is `"true"`/`"false"` not boolean                                                                                      |
| `exception.structured_frames` | string (JSON array) | Parsed stack frames. Each frame: `{"filename": "app.js", "function": "processOrder", "lineno": 42, "colno": 15, "abs_path": "/src/app.js", "in_app": true, "debug_id": "85314830-..."}`. When absent, the worker falls back to the raw `exception.stacktrace` string |
| `exception.debug_id`          | string              | UUID linking the source file to its source map (TC39 debug-id proposal). Used for server-side stack trace desymbolication                                                                                                                                            |

### Default fingerprint computation (server-side, in the worker)

When `exception.fingerprint` is not set by the SDK, the worker computes a default:

1. If `exception.structured_frames` has frames with `in_app: true` → hash `[exception.type, top_in_app_frame.function]`
2. If no structured frames → hash `[exception.type, stripped_message]` where stripped_message has numbers, hex strings, and UUIDs replaced with `<N>`, `<hex>`, `<uuid>` to group messages that differ only in dynamic values
3. If neither type nor message → hash `["unknown"]`

The `projectId` is always prepended to the fingerprint array before hashing: `hashFingerprint([projectId, ...fingerprint])`. This makes `FingerprintHash` globally unique across projects. Two projects with identical errors produce different hashes, so fingerprint hashes never collide across projects.

The hash is FNV-1a 128-bit, stored as a 32-character hex string in `FingerprintHash`.

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

### How custom events flow through the system

```text
SDK: track("signup_started", { plan: "pro" })
  |
  v
OTel Logger.emit({
  body: "signup_started",
  eventName: "signup_started",
  attributes: {
    "event.name": "signup_started",
    "custom.plan": "pro",
    "session.id": "...",
    "url.path": "/pricing",
    "user.id": "user_123"
  }
})
  |
  v  OTLP HTTP/JSON POST /v1/logs
  |
  v
Worker:
  1. transformLogs() → writes to otel_logs (unchanged)
  2. no extra extraction step needed
  3. later SQL can select only events with `mapContains(LogAttributes, 'event.name')`
```

This convention matters because **browser and backend custom events can share the same `otel_logs` table** while still being easy to query separately from ordinary logs.

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

Run from the `otel-collector/` directory.

## Example app (collecting real OTel data)

`example-app/` is a Spiceflow app with an integration test suite that sends real OTel telemetry (traces, logs, metrics, errors) through the full pipeline: SDK → collector → Tinybird/ClickHouse. The tests exercise different error types, custom events, and spans so the data can later be queried via the CLI (`strada issues list`, `strada issues view`, `strada query`).

Run the tests with the project ID and ingest endpoint as env vars:

```bash
STRADA_PROJECT_ID=01KPVGTT9CJW4ZNEF414VHGRFD \
STRADA_ENDPOINT=https://01KPVGTT9CJW4ZNEF414VHGRFD-ingest.strada.sh \
pnpm vitest run
```

Run from the `example-app/` directory. Tests skip automatically when env vars are missing.

Get the project ID and endpoint from `strada projects list` (the endpoint is `https://{projectId}-ingest.strada.sh`).

To test new CLI features or validate the ingest pipeline, add more routes and test cases to `example-app/src/index.test.ts`. Each route should emit different OTel signals (traces, logs, errors with various exception types, custom events). After the tests run and data propagates to Tinybird, query it with the CLI:

```bash
strada issues list -p example-app --since 1h
strada issues view <fingerprint> -p example-app
strada query "SELECT * FROM otel_errors LIMIT 10" -p example-app
```

## Reference schema

The Tinybird OTel template (https://github.com/tinybirdco/tinybird-otel-template) is the base inspiration for our OTel schema and SQL query examples. Our `tinybird/datasources/` files are derived from it with project isolation additions. Use it as reference for column names, types, indexes, sorting keys, and example queries against OTel data in ClickHouse.

## Tinybird

We target **Tinybird Forward** (the new CLI-based experience), not Classic. Forward is the actively developed version.

To read tinybird docs you can find pages here https://www.tinybird.co/docs/sitemap.xml. you can grep by key words and read relevant pages via webfetch.

**Classic vs Forward differences that matter to us:**

- Forward dropped `sql_filter` on static tokens. Use JWT `filter` instead
- Forward JWTs support `DATASOURCES:READ` scope with `filter` field (Classic JWTs only had `PIPES:READ`)
- Forward uses `tb deploy` instead of `tb push`

### Authenticating with `tb` CLI

The Strada workspace is on `us-east (aws)` (`https://api.us-east.aws.tinybird.co`). To authenticate:

```bash
# Launch browser login in a background session (keeps it alive for the callback)
bunx tuistory launch "tb --cloud login --method browser" -s tb-login --no-wait

# Wait for the browser prompt
bunx tuistory -s tb-login wait "/Opening browser|manually/i" --timeout 15000

# Read output to get the URL if browser didn't open
bunx tuistory -s tb-login read

# After approving in the browser, check it succeeded
bunx tuistory -s tb-login wait "/authenticated/i" --timeout 60000
bunx tuistory -s tb-login close
```

This creates a `.tinyb` file in the current directory with the workspace token. After login, all `tb` commands need `--cloud` to target the remote workspace (without it, `tb` defaults to local Docker mode).

```bash
# Verify auth works
tb --cloud workspace current
```

## Debugging ingestion with quarantine tables

Tinybird does **not** support disabling quarantine or failing at ingestion time. Rows that don't match the schema are silently moved to a quarantine table instead of being rejected. The Events API response includes `quarantined_rows` in the JSON body, so the collector can detect issues.

Every datasource has an associated `{datasource_name}_quarantine` table. Use `tb sql` to inspect quarantined rows:

```bash
# See recent quarantined rows for a specific table
tb --cloud sql "SELECT * FROM otel_traces_quarantine ORDER BY insertion_date DESC LIMIT 20"
tb --cloud sql "SELECT * FROM otel_logs_quarantine ORDER BY insertion_date DESC LIMIT 20"

# See distinct error types to understand what's failing
tb --cloud sql "SELECT DISTINCT c__error FROM otel_traces_quarantine"

# See quarantine activity over time (useful to spot when ingestion broke)
tb --cloud sql "SELECT toDate(insertion_date) AS day, count() FROM otel_traces_quarantine GROUP BY day ORDER BY day DESC"
```

Quarantine table extra columns:
- `c__error_column` Array(String) — column names with invalid values
- `c__error` Array(String) — error messages explaining why each column failed
- `c__import_id` Nullable(String) — job identifier
- `insertion_date` DateTime — when the row was quarantined (use this to correlate with deploy/code changes)

## Reading worker logs (wrangler tail)

Cloudflare Workers Observability is enabled (`observability.enabled: true` in both `website/wrangler.jsonc` and `otel-collector/wrangler.jsonc`). Logs are retained for 7 days and visible in the dashboard Query Builder.

There is no CLI command to query historical logs. `wrangler tail` streams logs in real time. To capture logs for debugging, run it in the background, trigger the traffic, then read the output.

**Cloudflare account ID:** `103e73569e2f6d4aea0fb679ceb8709b`

### Collector logs

```bash
# Check if a tail session is already running
bunx tuistory sessions

# If collector-tail exists, just read from it. Otherwise start a new one:
bunx tuistory launch "pnpm wrangler tail --format json" -s collector-tail --cwd otel-collector --no-wait

# Wait for wrangler to connect
bunx tuistory -s collector-tail wait "/Connected/i" --timeout 15000

# Generate traffic (e.g. run example-app tests)
STRADA_PROJECT_ID=01KPVGTT9CJW4ZNEF414VHGRFD \
STRADA_ENDPOINT=https://01KPVGTT9CJW4ZNEF414VHGRFD-ingest.strada.sh \
pnpm vitest run  # run from example-app/

# Read captured logs
bunx tuistory -s collector-tail read

# Stop tail when done
bunx tuistory -s collector-tail press ctrl c
bunx tuistory -s collector-tail close
```

### Website logs

```bash
# Same pattern for the website worker
bunx tuistory launch "pnpm wrangler tail --format json" -s website-tail --cwd website --no-wait
```

### Output format

Each JSON object in the tail output contains:

| Field | Description |
| ----- | ----------- |
| `outcome` | `"ok"` or `"exception"` |
| `wallTime` | Wall clock time in ms |
| `event.request.url` | The request URL |
| `event.request.method` | HTTP method |
| `event.response.status` | HTTP status code |
| `logs` | Array of `console.log` output from the worker |
| `exceptions` | Array of uncaught exceptions |

### Filtering with jq

```bash
# Show only errors
cat /tmp/collector-tail.log | jq -c 'select(.outcome == "exception" or .event.response.status >= 400)'

# Show URLs and status codes
cat /tmp/collector-tail.log | jq -c '{url: .event.request.url, status: .event.response.status, outcome: .outcome}'

# Show entries with console.log output
cat /tmp/collector-tail.log | jq -c 'select(.logs | length > 0)'
```

### Dashboard Query Builder (historical logs, last 7 days)

For querying past logs without real-time tail, use the Cloudflare dashboard:
1. Go to Workers & Pages → select worker → Observability
2. Use the Query Builder to filter by time range, status codes, etc.

Dashboard URL: https://dash.cloudflare.com/103e73569e2f6d4aea0fb679ceb8709b/workers-and-pages/observability

## Writing SQL queries (ClickHouse / Tinybird)

All user-facing queries run through Tinybird's `/v0/sql` endpoint with a scoped JWT. The SQL dialect is **ClickHouse SQL**. Follow these rules to keep queries fast, correct, and safe.

### Core principles

1. **Filter early.** Put WHERE clauses first to minimize the data ClickHouse reads. Filter on sorting key columns (`ServiceName`, `FingerprintHash`, `Timestamp`) whenever possible.
2. **Select only needed columns.** Never use `SELECT *` in application queries. List the exact columns you need. Wide reads waste I/O and bandwidth.
3. **Always add LIMIT.** Every query must have a `LIMIT` clause. Even aggregations that expect 1 row should use `LIMIT 1` as a safety net. Unbounded queries can scan the entire table.
4. **Never reference `ProjectId`.** The JWT filter injects `WHERE ProjectId = '...'` automatically. Adding it in SQL is redundant and error-prone. If a query uses `SELECT *`, `ProjectId` will appear in results but has no application meaning.

### Operation order

Structure queries in this order for readability and performance:

```sql
SELECT columns
FROM table
WHERE filters          -- 1. filter early
GROUP BY keys          -- 2. aggregate
ORDER BY ...           -- 3. sort
LIMIT N                -- 4. always limit
```

### Filtering before aggregation

Always filter in WHERE before GROUP BY, not in HAVING. WHERE filters skip data at the storage level; HAVING filters after ClickHouse already read and grouped everything.

```sql
-- GOOD: filter before grouping
SELECT FingerprintHash, count() AS c
FROM otel_errors
WHERE Timestamp >= now() - INTERVAL 24 HOUR
GROUP BY FingerprintHash
ORDER BY c DESC
LIMIT 20

-- BAD: reads all data then filters
SELECT FingerprintHash, count() AS c
FROM otel_errors
GROUP BY FingerprintHash
HAVING max(Timestamp) >= now() - INTERVAL 24 HOUR
ORDER BY c DESC
LIMIT 20
```

### Filtering before JOINs

When joining tables, filter each side before the JOIN. Do not join first and filter after.

### Map column access

Use `mapContains()` to check for key existence, bracket syntax `Map['key']` to read values:

```sql
-- check if a log is a custom event
WHERE mapContains(LogAttributes, 'event.name')

-- read a specific attribute value
LogAttributes['session.id'] AS session_id
```

### Time filtering patterns

Use ClickHouse's `now()` and `INTERVAL` syntax for relative time filters:

```sql
WHERE Timestamp >= now() - INTERVAL 1 HOUR
WHERE Timestamp >= now() - INTERVAL 7 DAY
```

### Aggregation functions

- `count()` for counts (not `count(*)`)
- `anyLast()` for picking one representative value from a group
- `groupUniqArray()` for collecting distinct values into an array
- `countIf(condition)` for conditional counting in a single pass
- Use `-Merge` combinators (`uniqMerge`, `countMerge`) when reading from `AggregatingMergeTree` tables (`otel_analytics_pages`, `otel_analytics_sessions`)

### Avoid

- **CTEs** (`WITH ... AS`). Use subqueries instead; Tinybird does not optimize CTEs well.
- **Nested aggregates** like `max(count(...))`. Use a subquery instead.
- **`SELECT *`** in application code. Always list columns explicitly.
- **Unbounded queries** without LIMIT. Even `GROUP BY` queries need a LIMIT.
- **`HAVING` for row-level filters.** Move them to WHERE.
- **String interpolation for user input.** Use parameterized values or validate inputs before embedding in SQL.

## opentelemetry docs

to read docs of OTEL packages and spec you can opensrc https://github.com/open-telemetry/opentelemetry.io and grep files inside content/en/docs which contain all the docs as markdown files.


## tinybird client

put type safe tb client methods in cli/src/tinybird.ts

website has a dev dependency on it.
