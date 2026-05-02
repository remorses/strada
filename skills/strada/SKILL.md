---
name: strada
description: >
  Strada is an open-source OpenTelemetry observability platform (error tracking, tracing, logs,
  metrics, browser analytics) that stores data in ClickHouse/Tinybird. ALWAYS load this skill
  when you need to interface with the Strada CLI, read or debug a project issue via
  OpenTelemetry data collected by Strada, or set up and configure a project that uses Strada
  for OpenTelemetry data ingestion.
---

# Strada

Open-source Sentry/Datadog alternative built on the OpenTelemetry standard. Users send OTel data via standard SDKs, Strada stores it in their own ClickHouse database (Tinybird as first-class backend), and they query it with SQL.

## What is Strada

Read the root README to understand what Strada is, why it exists, and how it compares to alternatives:

```bash
cat README.md # read the full output, NEVER pipe to head/tail
```

## CLI reference

The `strada` CLI is the main interface for managing projects, querying data, listing errors, and viewing analytics. Always run help first to see all available commands before using the CLI:

```bash
strada --help # NEVER pipe to head/tail, read the full output
```

## Project management

```bash
# Create a new project
strada projects create my-app

# Create another org-wide token for server-side ingest
strada tokens create production-server

# List all projects (shows slug and project ID)
strada projects list

# Query data for a project using ClickHouse SQL
strada query "SELECT count() FROM otel_errors WHERE Timestamp >= now() - INTERVAL 24 HOUR LIMIT 1" -p my-app

# List recent errors
strada issues list -p my-app --since 24h
```

The `-p` flag takes a project slug. You get the slug from `strada projects list`.

All queries use **ClickHouse SQL**. You can use any ClickHouse SQL syntax, functions, and operators. The query runs against the project's Tinybird/ClickHouse database with automatic project-scoped filtering via JWT.

## Setting up a TypeScript or JavaScript project

Read the SDK README for full setup instructions, API reference, and code examples for every runtime (Node.js, browser, Cloudflare Workers):

```bash
cat sdk/README.md # read the full output, NEVER pipe to head/tail
```

The SDK package is `@strada.sh/sdk`. The import path auto-resolves by runtime: browsers get the browser entry, Workers get the Workers entry, Node.js gets the server entry. One import path works everywhere.

```ts
import { initStrada, captureException } from "@strada.sh/sdk"

initStrada({
  projectId: "<project-id>",
  token: process.env.STRADA_TOKEN,
  service: "my-app",
})
```

Get the project ID and first server-side token from `strada projects create <slug>`. Create more
org-wide ingest tokens later with `strada tokens create <name>`. Omit `token` in browser apps;
browser ingest is anonymous and rate limited.

## Common mistakes

**Never reference ProjectId in SQL queries.** The Tinybird JWT injects `WHERE ProjectId = '...'` automatically on every query. Adding it manually is redundant and error-prone.

**Always add LIMIT to every query.** Unbounded queries scan the entire table. Even aggregations that expect one row should use `LIMIT 1`.

**Column names are PascalCase.** The OTel ClickHouse schema uses PascalCase: `TraceId`, `SpanName`, `ServiceName`, `ExceptionType`, not `trace_id` or `span_name`. This is the standard OTel ClickHouse exporter convention.

**Use repeatable -p flags, not comma-separated.** Pass multiple projects as `-p frontend -p api`, never `-p frontend,api`.

**No CTEs in Tinybird SQL.** Tinybird does not optimize `WITH ... AS` well. Use subqueries instead.

**Filter in WHERE, not HAVING.** `WHERE` filters skip data at the storage level. `HAVING` filters after ClickHouse already read and grouped everything.

**Map column access.** Use `mapContains(LogAttributes, 'event.name')` to check key existence and `LogAttributes['key']` to read values.

**Time filtering.** Use ClickHouse interval syntax: `WHERE Timestamp >= now() - INTERVAL 1 HOUR`, not string comparisons.

**Aggregation on MV tables.** Analytics tables (`otel_analytics_pages`, `otel_analytics_sessions`) use `AggregatingMergeTree`. Read with `-Merge` combinators: `uniqMerge(Visits)`, `countMerge(Hits)`, never plain `count()` or `uniq()` on those columns.

## Tables

The main tables you can query:

| Table | Contains |
|-------|----------|
| `otel_traces` | Spans (HTTP requests, DB queries, function calls) |
| `otel_logs` | Log records and custom events |
| `otel_errors` | Extracted exceptions grouped by fingerprint |
| `otel_analytics_pages` | Pre-aggregated pageview data (MV) |
| `otel_analytics_sessions` | Pre-aggregated session data (MV) |
| `otel_metrics_gauge` | Gauge metric snapshots |
| `otel_metrics_sum` | Cumulative counter metrics |
| `otel_metrics_histogram` | Distribution metrics |

## Useful query patterns

```sql
-- Recent errors grouped by type
SELECT FingerprintHash, anyLast(ExceptionType) AS type,
       anyLast(ExceptionMessage) AS message, count() AS events
FROM otel_errors
WHERE Timestamp >= now() - INTERVAL 24 HOUR
GROUP BY FingerprintHash
ORDER BY events DESC
LIMIT 20

-- Custom events from browser
SELECT Timestamp, LogAttributes['event.name'] AS event,
       LogAttributes['user.id'] AS user_id
FROM otel_logs
WHERE mapContains(LogAttributes, 'event.name')
ORDER BY Timestamp DESC
LIMIT 100

-- Slow spans
SELECT SpanName, ServiceName, Duration / 1e6 AS duration_ms
FROM otel_traces
WHERE Duration > 1000000000
ORDER BY Duration DESC
LIMIT 20
```
