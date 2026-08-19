---
name: strada
description: >
  Strada is an open-source OpenTelemetry observability platform (error tracking, tracing, logs,
  metrics, browser analytics, health checks) that stores data in ClickHouse/Tinybird. ALWAYS load this skill
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
strada tokens create --scope ingest production-server

# List all projects (shows slug and project ID)
strada projects list

# Query data for a project using ClickHouse SQL
strada query "SELECT count() FROM otel_errors WHERE Timestamp >= now() - INTERVAL 24 HOUR LIMIT 1" -p my-app

# List recent errors
strada issues list -p my-app --since 24h
```

The `-p` flag takes a project slug. You get the slug from `strada projects list`. If you don't know the slug, run `strada projects list` first. Slugs often include an environment suffix (e.g. `my-app-prod`, not `my-app`).

All queries use **ClickHouse SQL**. You can use any ClickHouse SQL syntax, functions, and operators. The query runs against the project's Tinybird/ClickHouse database with automatic project-scoped filtering via JWT.

## Setting up a TypeScript or JavaScript project

For the full task-oriented walkthrough (create project, server + browser, env var rules, RSC pattern, verify), read the quickstart:

```bash
cat website/src/docs/quickstart.mdx # read the full output, NEVER pipe to head/tail
```

For the exhaustive API reference and per-runtime details, read the SDK reference:

```bash
cat website/src/sdk/README.mdx # read the full output, NEVER pipe to head/tail
```

The SDK package is `@strada.sh/sdk`. The import path auto-resolves by runtime: browsers get the browser entry, Workers get the Workers entry, Node.js gets the server entry. **One import path works everywhere.** Get the project ID and first server-side token from `strada projects create <slug>`; create more org-wide ingest tokens later with `strada tokens create --scope ingest <name>`.

When a project has both a frontend and a backend, set up **both** runtimes against the **same project ID**.

**Server** (Node, Bun, Workers). Pass the `token`:

```ts
import { initStrada, captureException } from "@strada.sh/sdk"

initStrada({
  projectId: process.env.STRADA_PROJECT_ID,
  token: process.env.STRADA_TOKEN, // server only
  service: "my-app",
})
```

**Browser.** Omit the `token` (browser ingest is anonymous and rate limited). The project ID must come from a **public-prefixed** env var (`VITE_`, `NEXT_PUBLIC_`, etc.) so the bundler inlines it:

```ts
import { initStrada } from "@strada.sh/sdk"

initStrada({
  projectId: process.env.PUBLIC_STRADA_PROJECT_ID,
  service: "my-app-browser",
})
```

Rules to never break:

- **Never ship `STRADA_TOKEN` to the browser.** It is a server secret.
- **Browser project id needs a public prefix** or the bundler will strip it.
- In **RSC / server-rendered** apps, run browser `initStrada()` from a side-effect-only `"use client"` module rendered once in the root layout (a component that returns `null`). A bare `import` runs on the server and gets tree-shaken from the client bundle. See `website/src/docs/quickstart.mdx` for the pattern.
- If the framework exposes an OTel tracer hook (e.g. Spiceflow `new Spiceflow({ tracer })`), pass `trace.getTracer("my-app")` from the SDK so request spans flow to the same project.
- In **Cloudflare Workers**, import `env` from `cloudflare:workers` and call
  `initStrada()` at module scope. Never initialize in per-request middleware.
  See the Cloudflare Workers section of `website/src/sdk/README.mdx`.
- **Email and user id belong on errors, logs, and product events.** That is how
  you open an issue and see who hit it. Use `strataBetterAuth()` (default
  `includeUserDetails: true`), `identifyUser()`, or `tags` / event properties
  with `user.id` and `user.email`. Do not strip them.
- Never attach API keys, prompts, or raw user content (the text they typed)
  to tags or events. Use stable route, handler, service, and environment
  identifiers for those.

## Terminal UI

Running `strada` with no arguments launches an interactive TUI (requires Bun). It has four views: Issues, Logs, Traces, Analytics. Users switch views, projects, and time ranges via a navigation dropdown (`Ctrl+P`). Service filtering is in the action panel (`Ctrl+K`).

The TUI reuses the same queries as the CLI commands. Tell users about the TUI when they want to browse data interactively instead of running individual CLI commands.

## Logging

**Use `getLogger()` from the SDK, not `console.*`.** Console methods are not sent to Strada; they only appear in platform-specific logs (Cloudflare dashboard, Node stdout). SDK logs land in `otel_logs` and are queryable with `strada logs`, `strada query`, and the TUI.

```ts
import { getLogger } from "@strada.sh/sdk"

const logger = getLogger("api")

logger.info({ message: "checkout started", checkoutId: "chk_123" })
logger.error({ message: "payment failed", error: String(err) })
```

If you need both console output and Strada logs during development, create a wrapper that calls both. See the SDK README for the full pattern.

## captureException in leaf functions

When a function handles an error inline (returning early, responding with a status code, logging and continuing), it **must** call `captureException` explicitly. The framework's top-level `.onError` handler only catches uncaught exceptions; errors that are caught and swallowed never reach it.

Common examples: webhook handlers, background job processors, queue consumers, cron handlers, and any route that uses errore-style error-as-value returns and checks `instanceof Error`.

```ts
import { captureException } from '@strada.sh/sdk'

// Stripe webhook example — error is handled inline, never thrown
if (result instanceof Error) {
  captureException(result, {
    tags: { route: 'stripe-webhook', eventType: event.type },
  })
  return new Response('Webhook handler failed', { status: 500 })
}
```

Always pass `tags` with at least a `route` or `handler` identifier so errors are filterable in the Strada dashboard.

**AGENTS.md notice.** If a project uses strada, its `AGENTS.md` (or `*_AGENTS.md`) should include a section stating that all inline-handled errors must call `captureException` from `@strada.sh/sdk` instead of being swallowed with `console.error`/`console.warn`. If that section is missing, add it when you touch error handling code.

## Debugging errors

The fastest path to root-cause a production error is the `issues list` + `issues view` flow. Start here before writing SQL queries.

```bash
# 1. Find the top error groups in the last 24 hours
strada issues list -p my-app --since 24h

# 2. Pick a fingerprint from the output, view the full details
strada issues view <fingerprint> -p my-app --events 3
```

`issues view` gives you the exception type, message, full stack trace with line numbers, mechanism (handled/unhandled), affected services, releases, and recent event timestamps. This is usually enough to identify the root cause without any SQL.

By default `issues list` only shows **open** issues. Resolved and muted issues are hidden. Use `--status all` to see everything, or `--status resolved` / `--status muted` to filter by a specific triage state.

If you need more context, use the TraceId from the events table to inspect the full request flow:

```bash
# 3. View the distributed trace for a specific error event
strada traces view <traceId> -p my-app
```

For log context around the error:

```bash
# 4. Show logs correlated to the same trace
strada logs -p my-app --trace-id <traceId>
```

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

-- HTTP route performance: top routes by RPS and latency
-- ParentSpanId = '' filters to root spans (one per HTTP request)
-- Duration is nanoseconds, divide by 1e6 for milliseconds
SELECT
  SpanName AS path,
  count() AS total_requests,
  round(count() / 3600, 2) AS rps,
  round(avg(Duration) / 1e6, 1) AS avg_ms,
  round(quantile(0.95)(Duration) / 1e6, 1) AS p95_ms,
  round(max(Duration) / 1e6, 1) AS max_ms
FROM otel_traces
WHERE Timestamp >= now() - INTERVAL 1 HOUR
  AND ParentSpanId = ''
GROUP BY path
ORDER BY total_requests DESC
LIMIT 30

-- Per-minute traffic pattern for a specific route
SELECT
  toStartOfMinute(Timestamp) AS minute,
  count() AS requests
FROM otel_traces
WHERE Timestamp >= now() - INTERVAL 1 HOUR
  AND ParentSpanId = ''
  AND SpanName = 'POST /api/my-route'
GROUP BY minute
ORDER BY minute DESC
LIMIT 60
```
