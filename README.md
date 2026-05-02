<div align='center'>
    <br/>
    <br/>
    <h3>strada</h3>
    <p>Open-source observability you own. Errors, logs, traces, analytics. One database, one CLI.</p>
    <br/>
    <br/>
</div>

Strada replaces Sentry, Datadog, and Google Analytics with a single open-source stack built on [OpenTelemetry](https://opentelemetry.io). Your data lives in **your own ClickHouse database**. You query it with **SQL from the CLI**. Agents can monitor, debug, and fix issues end-to-end without touching a browser.

The Strada Node SDK bundle is **4.8× smaller than Sentry's Node SDK** when bundled with esbuild. Smaller bundles mean **faster cold starts** in Vercel, AWS Lambda, Cloudflare Workers, and other serverless runtimes. Strada stays small because it is a thin layer on top of **standard OpenTelemetry**, not a proprietary vendor SDK you have to rip out later.

```
Bundle size, esbuild ESM, node18 target

Strada SDK   400.5 kB  ██████████  281 modules
Sentry SDK  1908.6 kB  ████████████████████████████████████████████████  653 modules

Sentry is 4.8× larger.
```

```
npm install @strada.sh/sdk
```

```ts
import { initStrada, captureException, track } from "@strada.sh/sdk"

initStrada({ projectId: "01JTHG...", token: process.env.STRADA_TOKEN, service: "api" })

// errors, traces, logs, metrics, custom events
// all flow through standard OpenTelemetry to your database
```

## What Strada replaces

```
  Sentry                   Datadog                Google Analytics          Grafana
  errors                   traces                 pageviews                dashboards
  issue grouping           logs                   sessions                 query & alerts
  alerts                   metrics                custom events            visualizations
      │                        │                        │                       │
      │                        │                        │                       │
      └────────────┬───────────┴────────────┬───────────┴───────────┬───────────┘
                   │                        │                       │
                   ▼                        ▼                       ▼
       ┌───────────────────────────────────────────────────────────────────────────────┐
       │                                  Strada                                       │
       │                                                                               │
       │   one CLI ────────► one database ────────► one SQL dialect                    │
       │                                                                               │
       │   errors ───► traces ───► logs ───► metrics ───► analytics ───► events        │
       └───────────────────────────────────────────────────────────────────────────────┘
```

All data lands in the **same ClickHouse database**, queryable with the **same SQL**. No context switching between tools.

## Use cases

- **Run SQL queries from agents**: agents call `strada query "SELECT ..."` to answer any question about your system. Raw ClickHouse SQL, no proprietary API
- **List and inspect issues**: agents run `strada issues list` to see error groups, read stacktraces, identify regressions, and open fix PRs
- **Read logs to debug issues**: agents query `otel_logs` filtered by trace ID, session, or time range to reconstruct what happened before a failure
- **Analyze and improve performance**: agents query span durations, identify slow endpoints, compare p95 latency across releases
- **Monitor payment funnels**: track `checkout_started` and `purchase_completed` as custom events. Query success rates with SQL to catch drops early
- **Debug by user session**: errors, pageviews, custom events, and backend traces for a single user in one query. Join across `otel_errors`, `otel_logs`, and `otel_traces`
- **Correlate errors with revenue**: compare error rates before and after a fix against conversion events to measure impact
- **Replace Google Analytics**: browser pageviews, sessions, referrers, devices, all stored in the same ClickHouse tables as errors and traces

## How it works

```
  Browser SDK                          Node SDK                         Workers SDK
  (pageviews, track, errors)           (traces, logs, metrics)          (captureException)
          │                                  │                                │
          │            OTLP HTTP/JSON        │          OTLP HTTP/JSON        │
          ▼                                  ▼                                ▼
  ┌─────────────────────────────────────────────────────────────────────────────────────────┐
  │                               Strada OTLP Collector                                     │
  │                           (Cloudflare Worker, open source)                              │
  └────────┬─────────────────────┬─────────────────────┬─────────────────────┬──────────────┘
           │                     │                     │                     │
           ▼                     ▼                     ▼                     ▼
     otel_traces             otel_logs           otel_metrics          otel_errors
           │                     │                                          ▲
           │                     ├───────► extract exceptions ──────────────┘
           ▼                     ▼
     otel_analytics_pages ◄──────────── materialized views
     otel_analytics_sessions
```

Every feature maps to a standard **OpenTelemetry signal**:

- **Errors** = OTel log records or span events with `exception.*` attributes, extracted into `otel_errors`
- **Traces** = OTel spans with parent/child relationships in `otel_traces`
- **Logs** = OTel log records in `otel_logs`
- **Metrics** = OTel gauges, sums, histograms in `otel_metrics_*`
- **Analytics** = browser OTel pageview spans, aggregated by materialized views
- **Custom events** = OTel log records with `event.name` attribute

## Quick start

**1. Create your database**

```bash
strada database create
# Authenticates with Tinybird, deploys all tables and materialized views
```

**2. Create a project**

```bash
strada projects create my-app
# Returns a project ID, ingest endpoint, and a server-side token

strada setup --project my-app
# Saves this folder's default org/project in ~/.strada/config.json
```

`strada setup` binds the **current folder** to an organization and project. After setup, CLI commands run against that project implicitly, so you do not need to pass `--project my-app` to every command.

When you belong to multiple organizations or have multiple projects, run setup inside each app folder:

```bash
cd ~/code/acme-api
strada setup
# pick Acme / api

cd ~/code/personal-site
strada setup
# pick Personal / frontend
```

The mapping is stored outside your repo in `~/.strada/config.json`, not committed to source control. Strada resolves config by walking up from the current working directory and using the closest matching folder scope:

```json
{
  "scoped": {
    "/": {
      "sessionToken": "...",
      "baseUrl": "https://strada.sh"
    },
    "/Users/me/code/acme-api": {
      "orgId": "01HORG...",
      "orgName": "Acme",
      "projectId": "01HPROJ...",
      "projectSlug": "api"
    }
  }
}
```

**3. Send telemetry**

`strada projects create` prints a **token** once. Use that token in trusted server runtimes like
Node.js, Vercel, and Cloudflare Workers. If you need another one later, run
`strada tokens create production-server`. Browser apps should omit `token`; browser ingest is
anonymous and rate limited because browser secrets are public.

```ts
import { initStrada, captureException, track, trace } from "@strada.sh/sdk"

initStrada({
  projectId: "01JTHG5M7XPQR8KNCZ0W4D",
  token: process.env.STRADA_TOKEN,
  service: "api",
  environment: "production",
  version: "1.2.0",
  enabled: !import.meta.hot,
})

// enabled: false keeps OTel APIs local but sends nothing to ingest.
// In Vite/RSC dev servers, import.meta.hot is truthy during HMR.

// capture errors
try {
  await processPayment(order)
} catch (err) {
  captureException(err)
}

// create traces
const tracer = trace.getTracer("checkout")
const span = tracer.startSpan("process-order")
span.setAttribute("order.id", "ord_123")
span.end()

// track custom events
track("purchase_completed", { plan: "pro", amount: 49 })
```

**4. Query from the CLI**

```bash
# list error groups from the last 24 hours
strada issues list --since 24h

# view a specific error with stacktrace
strada issues view <fingerprint>

# browse recent logs
strada logs --since 1h
strada logs --min-level error --since 24h
strada logs --search "timeout" --service api

# filter by any attribute with --where (-w)
strada logs -w "mapContains(LogAttributes, 'event.name')"          # custom events only
strada logs -w "LogAttributes['user.id'] = 'user_123'"             # specific user
strada logs -w "LogAttributes['exception.type'] = 'TypeError'"     # specific error type

# log volume by service and severity
strada logs stats --since 24h

# run any SQL query
strada query "SELECT count() FROM otel_errors WHERE ExceptionType = 'TypeError'"

# browser analytics
strada analytics pages --since 7d
strada analytics sessions --since 24h

# custom events with attribute filters
strada analytics events -w "LogAttributes['custom.plan'] = 'pro'"    # events from pro users
strada analytics events -w "LogAttributes['user.id'] = 'user_123'"   # events from a user
```

## Built on OpenTelemetry

[OpenTelemetry](https://opentelemetry.io) is the industry standard for observability. It defines a common format for traces, logs, and metrics that works across every language, framework, and cloud provider.

Strada is **100% OpenTelemetry**. The SDK is a thin wrapper around the official OTel SDKs that configures providers, exporters, and a few convenience helpers. You can use your existing OTel setup to send data to Strada. It will just work.

```
  your code ──► initStrada() + captureException() + track()
                     │
                     ▼
  Strada SDK ────────────────► thin config wrapper ────────────────► OpenTelemetry SDK
                                                                          │
                                    TracerProvider ──► LoggerProvider ──► MeterProvider
                                                                           │
                                                                           │ OTLP HTTP/JSON
                                                                          ▼
                                                                   Strada Collector
                                                                   (Cloudflare Worker)
                                                                          │
                    ┌─────────────────┬───────────────────┬───────────────┤
                    │                 │                   │               │
                    ▼                 ▼                   ▼               ▼
              otel_traces         otel_logs         otel_errors     otel_metrics
                                                                          │
                                                          ClickHouse ◄────┘
                                                        (your database)
```

**If you already have OTel instrumentation**, point your OTLP exporter at your Strada ingest endpoint. No SDK swap needed.

**Strada adds a few extra attributes** on top of standard OTel to enable error tracking and analytics:

| Attribute | Purpose |
|-----------|---------|
| `session.id` | Per-tab browser session UUID for grouping pageviews |
| `user.id` | Signed-in user identity, propagated via W3C Baggage |
| `event.name` | Distinguishes custom events from ordinary logs |
| `exception.mechanism.type` | How an error was captured (onerror, unhandledrejection, etc.) |
| `exception.mechanism.handled` | Whether user code caught the error |
| `exception.fingerprint` | Custom grouping override for error deduplication |

These are regular OTel attributes. Any OTel SDK can set them.

## CLI-first, agent-first

Strada is designed for the terminal. Every operation is a CLI command. No clunky web UI that agents can't use.

```bash
strada query "SELECT ..."       # any ClickHouse SQL
strada issues list -p my-app    # error groups, sorted by frequency
strada issues view <fp>         # stacktrace, recent events, metadata
strada logs -p my-app           # browse logs, colored one-line output
strada logs stats -p my-app     # log volume by service and severity
strada analytics pages          # top pages, browsers, countries
strada analytics events         # custom events with properties
strada projects list            # list all projects
strada login                    # device flow auth
```

Agents can run `strada query` with raw SQL to answer any question about your system. No rate limits, no API keys to manage, no pagination tokens. Just SQL.

### Agent workflows

Give your agents the Strada CLI and they can:

- **Monitor and auto-fix**: run `strada issues list`, identify the top error, read the stacktrace, find the bug in your codebase, open a PR
- **Read logs to debug failures**: `strada logs -p my-app --min-level error --since 1h` to see recent errors, then `--trace-id` to follow a specific request across services
- **Debug payment flows**: `strada query "SELECT ... FROM otel_errors WHERE ExceptionMessage LIKE '%stripe%'"` to find all errors blocking Stripe subscriptions
- **Track ROI on bug fixes**: correlate error rates with revenue events. Did fixing that TypeError increase successful checkouts?
- **Build status pages**: query uptime and error rates via SQL, render them however you want

```bash
# example: find all unhandled errors in the checkout flow from the last hour
strada query "
  SELECT
    ExceptionType,
    ExceptionMessage,
    count() as occurrences
  FROM otel_errors
  WHERE SpanName LIKE '%checkout%'
    AND MechanismHandled = 'false'
    AND Timestamp >= now() - INTERVAL 1 HOUR
  GROUP BY ExceptionType, ExceptionMessage
  ORDER BY occurrences DESC
  LIMIT 20
" -p my-app
```

## Browser analytics

Browser analytics in Strada is just **OTel data sent from the browser**. Pageviews are spans. Custom events are log records. Sessions are grouped by a `session.id` UUID stored in `sessionStorage`.

```ts
import { initStrada, track } from "@strada.sh/sdk"

initStrada({
  projectId: "01JTHG5M7XPQR8KNCZ0W4D",
  service: "frontend",
})
// pageview tracking starts automatically

// track custom events
track("signup_started", { plan: "pro", source: "pricing-page" })
track("purchase_completed", { amount: 49 })
```

**User identification** works via a cookie called `strada_uid`. Set it when the user logs in:

```ts
document.cookie = `strada_uid=${user.id}; Path=/; SameSite=Lax; Secure`
```

The SDK reads this cookie automatically and injects `user.id` into every span, log, error, and custom event. It also propagates `user.id` to your backend via [W3C Baggage](https://www.w3.org/TR/baggage/), so backend traces within a browser request carry the same user identity.

### Why analytics + errors together matters

All your data is in the same database. You can join errors with analytics:

```sql
-- find which pages have the most errors
SELECT
  LogAttributes['url.path'] AS page,
  count() AS error_count
FROM otel_errors
WHERE Timestamp >= now() - INTERVAL 7 DAY
GROUP BY page
ORDER BY error_count DESC
LIMIT 10
```

```sql
-- get the full session timeline for a user who hit an error
SELECT Timestamp, ServiceName, SpanName, LogAttributes['event.name'] AS event
FROM otel_logs
WHERE LogAttributes['session.id'] = 'abc-123'
ORDER BY Timestamp ASC
```

This is hard to do when errors live in Sentry, analytics in Google Analytics, and traces in Datadog. In Strada it's one `SELECT`.

## You own your data

Strada does **not** host a database for you. Instead, it uses [Tinybird](https://www.tinybird.co) (managed ClickHouse) so you're never locked in.

- **One command setup**: `strada database create` deploys all tables, materialized views, and tokens to your Tinybird workspace
- **Also runs on plain ClickHouse**: point Strada at any ClickHouse instance. Same schema, same queries
- **Standard OTel schema**: column names follow the [official OTel ClickHouse exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/clickhouseexporter). No proprietary format
- **Self-host everything**: the entire infrastructure runs on Cloudflare Workers. Fork the repo and deploy with `wrangler deploy`
- **Or use strada.sh**: the managed service handles multi-tenancy, auth, team collaboration, and ingestion. You still own the database

```
                                                ┌─────────────────────────────────────────────┐
  strada.sh (managed) ─────────────────────────►│  Your Tinybird workspace                    │
  auth, teams, ingestion, CLI                   │                                             │
                                                │  otel_traces ─── otel_logs ─── otel_errors  │
                OR                              │  otel_metrics ─── otel_analytics_*          │
                                                │                                             │
  self-hosted (fork + wrangler deploy) ────────►│  same schema, same tables                   │
  Cloudflare Workers, zero lock-in              │  you own everything                         │
                                                └─────────────────────────────────────────────┘
```

### Why Tinybird

- **Fast**: ClickHouse is columnar, designed for analytical queries. Millions of spans in milliseconds
- **Just SQL**: no proprietary DSL. Standard ClickHouse SQL that your agents already know
- **Cheap storage**: $0.058/GB/month with ZSTD compression. Orders of magnitude less than Datadog
- **No idle cost**: pay only for active queries and ingestion. No traffic = minimal bill
- **Built-in isolation**: JWT row-level filtering scopes each project automatically

See the [Tinybird pricing breakdown](./docs/tinybird-pricing.md) for detailed cost estimates.

## SDK

The SDK works on **Node.js**, **browsers**, and **Cloudflare Workers**. One import path, resolved by export conditions:

```ts
import { initStrada, captureException, track, trace, logs, metrics } from "@strada.sh/sdk"
```

| Runtime | What it sets up |
|---------|----------------|
| **Node.js / Bun** | OTel providers, OTLP exporters, process error handlers, graceful shutdown |
| **Browser** | WebTracerProvider, pageview spans, session management, error/rejection handlers |
| **Cloudflare Workers** | BasicTracerProvider, auto-flush via `waitUntil`, zero overhead when unused |

After `initStrada()`, all standard OTel APIs work: `trace.getTracer()`, `logs.getLogger()`, `metrics.getMeter()`. The SDK re-exports these so you don't need `@opentelemetry/api` as a dependency.

**Convenience helpers** (optional, thin wrappers over OTel):

- `captureException(error)` normalizes errors, computes fingerprints, emits structured OTel log records
- `track(name, props)` emits custom events as OTel log records with `event.name` and `custom.*` attributes
- `setTags(tags)` sets tags merged into subsequent error attributes
- `flush()` / `shutdown()` for manual lifecycle control

See the full [SDK documentation](./sdk/README.md) for detailed API reference, auto-instrumentation setup, batching config, and browser/server context propagation.

## Sourcemaps

Strada does **not support sourcemap upload** right now. Instead, preserve function and class names in production builds:

```ts
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    rolldownOptions: {
      output: { keepNames: true },
    },
  },
})
```

Minifiers shorten variable names to save bytes. But gzip already compresses repeated strings. So the actual transfer size difference is tiny, while you get **readable stack traces** with zero extra infrastructure. No sourcemap upload steps, no build-time auth tokens, no release matching.

## Agent skill

Install the [skill](https://skills.sh) to teach AI agents the Strada workflows:

```bash
npx -y skills add remorses/strada
```

This works with Claude Code, Cursor, Windsurf, and other AI coding agents. The skill teaches them how to use the CLI, query data, debug errors, and work with the OTel schema.

## Docs

- [SDK reference](./sdk/README.md)
- [Browser analytics](./docs/browser-analytics.md)
- [Tinybird pricing breakdown](./docs/tinybird-pricing.md)
- [Cloudflare Workers OTel export](./docs/cloudflare-workers-otel-export.md)
