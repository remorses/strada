# Browser Analytics

Strada supports web analytics via standard OpenTelemetry. The browser SDK sends OTLP traces to the same collector used for backend observability. No separate pipeline, no separate schema, no proprietary tracker script.

## Core model

**Pageviews and auto-instrumented browser events** are spans in `otel_traces`. **Custom events** (tracked via `strada.track()`) are log records in `otel_logs`, following OTel's direction of using the Logs API for events.

```
otel_traces                              otel_logs
+-- span: pageview "/"                  +-- log: "button_click"
|   +-- span: fetch GET /api/user        +-- log: "form_submit"
+-- span: pageview "/pricing"           +-- log: "purchase"
+-- span: pageview "/dashboard"
```

- **Session** = one `session.id`, stored in `sessionStorage` (per-tab, survives page refreshes, cleared on tab close)
- **Pageview** = a span that starts on navigation and ends when the user navigates away or closes the tab
- **Custom event** = a log record in `otel_logs` with `event.name` set to the event name, correlated to the current pageview when one is active
- **Auto-instrumented events** (fetch, XHR, clicks) = standard OTel spans in `otel_traces`, usually parented to the current pageview span when no other span is active

Dashboard widgets each query a single table (MVs for pageview analytics, `otel_logs` for custom events). No joins needed. For advanced use cases like user timelines or mixed funnels, `UNION ALL` combines both tables.

For **dashboard queries** (top pages, top browsers, visitor counts, bounce rate), two **materialized views** pre-aggregate the data at ingest time into compact AggregatingMergeTree tables. This means dashboards query ~1000x fewer rows than scanning `otel_traces` directly, and analytics data can have its own retention (90 days) independent of raw trace retention (7 days).

---

## Where the data comes from

Every field needed for analytics comes from standard OTel attributes. Here's the full mapping:

### What the OTel browser SDK provides (no Strada code needed)

The `@opentelemetry/opentelemetry-browser-detector` package detects browser info from `navigator.userAgentData` and `navigator.language` automatically and sets these **resource attributes**:

| Resource attribute    | Source                       | Example value          |
|-----------------------|------------------------------|------------------------|
| `browser.platform`    | `navigator.userAgentData.platform` | `"macOS"`, `"Windows"` |
| `browser.mobile`      | `navigator.userAgentData.mobile`   | `"false"`              |
| `browser.language`    | `navigator.language`               | `"en-US"`              |
| `browser.brands`      | `navigator.userAgentData.brands`   | `"Google Chrome 147, Chromium 147"` |
| `user_agent.original` | `navigator.userAgent`              | `"Mozilla/5.0 ..."` (full UA string) |

The `@opentelemetry/instrumentation-document-load` sets URL attributes on document load spans:

| Span attribute          | Source                | Example value                        |
|-------------------------|-----------------------|--------------------------------------|
| `url.full`              | `window.location.href`| `"https://app.acme.com/pricing?plan=pro"` |
| `http.url`              | same (deprecated)     | same                                 |

### What the Strada browser SDK adds

The Strada SDK is a thin wrapper around the standard OTel browser SDK. It adds:

| Span attribute                  | How it's set                           | Example value                   |
|---------------------------------|----------------------------------------|---------------------------------|
| `session.id`                    | `sessionStorage` per-tab UUID          | `"f47ac10b-58cc-..."`           |
| `url.path`                      | `window.location.pathname`             | `"/pricing"`                    |
| `url.query`                     | `window.location.search`               | `"?plan=pro"`                   |
| `http.request.header.referer`   | `document.referrer`                    | `"https://google.com"`          |
| `user.id`                       | Read from `strada_uid` cookie          | `"user_123"`                    |

These are injected by a custom `SpanProcessor` that enriches every span before export.

### What the collector injects server-side

Two attributes are **not available in the browser** and must be injected by the Strada collector when it receives the OTLP request:

| Span attribute         | Source                    | Example value | Why server-side? |
|------------------------|---------------------------|---------------|-------------------|
| `geo.country`          | `CF-IPCountry` header     | `"IT"`        | IP geolocation requires a server; browsers can't resolve their own country from IP |
| `user_agent.original`  | `User-Agent` header       | `"Mozilla/5.0 ..."` | Fallback. The browser detector sets this as a resource attribute, but the collector also injects it as a span attribute so the MV can access it uniformly from `SpanAttributes` without reading `ResourceAttributes` |

The collector change is small: read two headers from the request and merge them into `span_attributes` of every trace row before writing to Tinybird/ClickHouse. This is useful for all traces (not just analytics), so it's a general enrichment, not analytics-specific.

### Data flow summary

```
Browser (OTel SDK)                     Collector (Cloudflare Worker)
+-------------------------------+      +----------------------------------+
| Resource attributes:          |      |                                  |
|   browser.platform            |      |  Reads from request headers:     |
|   browser.mobile              | ---> |    CF-IPCountry -> geo.country   |
|   browser.language            |      |    User-Agent   -> user_agent    |
|   browser.brands              |      |                                  |
|   user_agent.original         |      |  Injects into span_attributes    |
|                               |      |  of every row                    |
| Span attributes:              |      |                                  |
|   session.id                  |      |  Writes to otel_traces           |
|   url.path                    |      |         |                        |
|   url.query                   |      |         v                        |
|   url.full                    |      |  MV fires automatically          |
|   http.request.header.referer |      |    otel_analytics_pages          |
|   user.id                     |      |    otel_analytics_sessions       |
+-------------------------------+      +----------------------------------+
```

**The ingestion pipeline (`POST /v1/traces`) does not change.** Browser spans go through the same endpoint as backend spans. The only collector change is the header enrichment (2 attributes). The MVs fire automatically on every insert to `otel_traces`.

---

## Session ID

```typescript
const sessionId =
  sessionStorage.getItem('strada.session_id') ??
  (() => {
    const id = crypto.randomUUID()
    sessionStorage.setItem('strada.session_id', id)
    return id
  })()
```

- Per-tab, per-origin
- No cookies, no consent banner needed
- `session.id` is NOT a user identifier; it is a visit identifier
- When the user is logged in, `user.id` is set as a separate attribute

---

## Span attributes

### Resource attributes (set once on SDK init)

```json
{
  "service.name": "my-app",
  "service.version": "1.4.2",
  "deployment.environment.name": "production",
  "browser.platform": "macOS",
  "browser.mobile": false,
  "browser.language": "en-US",
  "browser.brands": "Google Chrome 147, Chromium 147",
  "user_agent.original": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ..."
}
```

These come from `@opentelemetry/opentelemetry-browser-detector` automatically. No Strada code needed.

### Pageview span

```json
{
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "parentSpanId": null,
  "name": "pageview",
  "kind": "INTERNAL",
  "startTimeUnixNano": "1711541826000000000",
  "endTimeUnixNano": "1711541871000000000",
  "attributes": {
    "session.id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "url.full": "https://app.acme.com/pricing",
    "url.path": "/pricing",
    "url.query": "?plan=pro",
    "http.request.header.referer": "https://google.com",
    "user.id": "user_123",
    "geo.country": "IT"
  },
  "resource": {
    "service.name": "my-app",
    "service.version": "1.4.2",
    "browser.platform": "macOS"
  }
}
```

`geo.country` is injected server-side by the Strada collector from the `CF-IPCountry` Cloudflare header. No client-side geolocation needed.

### Custom event log record

Custom events are **log records** in `otel_logs`, not spans. They are correlated to the active pageview span via `TraceId` and `SpanId` while that pageview is open.

```json
{
  "timeUnixNano": "1711541840000000000",
  "severityNumber": 9,
  "severityText": "INFO",
  "body": "button_click",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "attributes": {
    "event.name": "button_click",
    "session.id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "url.path": "/pricing",
    "url.full": "https://app.acme.com/pricing",
    "user.id": "user_123",
    "custom.element": "cta-hero",
    "custom.text": "Start free trial",
    "custom.plan": "pro"
  },
  "resource": {
    "service.name": "my-app",
    "service.version": "1.4.2",
    "browser.platform": "macOS"
  }
}
```

- `TraceId` and `SpanId` point to the active pageview span when the event is emitted during an open pageview
- `event.name` is the structured event name for filtering/grouping
- `custom.*` prefix isolates user-defined properties from standard OTel attributes
- `session.id`, `url.path`, `user.id` are injected automatically by the SDK's log processor
- The log record lands in `otel_logs` via `POST /v1/logs` (same collector endpoint used for backend logs)

### Auto-instrumented fetch span

```json
{
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "b3d7c2e1f8a90b4c",
  "parentSpanId": "00f067aa0ba902b7",
  "name": "GET /api/plans",
  "kind": "CLIENT",
  "startTimeUnixNano": "1711541828000000000",
  "endTimeUnixNano": "1711541829450000000",
  "attributes": {
    "http.request.method": "GET",
    "url.full": "https://api.acme.com/api/plans",
    "http.response.status_code": 200,
    "session.id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  }
}
```

This span is created automatically by `@opentelemetry/instrumentation-fetch`. The `session.id` is injected by the custom span processor.

---

## Auto-instrumentation

The Strada browser SDK wraps `@opentelemetry/auto-instrumentations-web`, which instruments 4 things automatically with zero code changes:

| Package | What it captures |
|---|---|
| `instrumentation-document-load` | Full page load waterfall: navigation timing, each resource (JS, CSS, images) as child spans |
| `instrumentation-fetch` | Every `fetch()` call -> span with method, URL, status code, duration |
| `instrumentation-xml-http-request` | Every XHR call (Axios, legacy libs) -> same as fetch |
| `instrumentation-user-interaction` | Click events -> span per click, named after the element |

### What you get for free on page load

```
span: documentLoad "/"             [0ms -> 1240ms]
+-- span: resourceFetch "main.js"  [45ms -> 320ms]
+-- span: resourceFetch "app.css"  [45ms -> 180ms]
+-- span: fetchRequest "GET /api"  [800ms -> 1100ms]
```

This is already Core Web Vitals territory. You can see slow resource loads and blocking API calls per pageview without writing a line of instrumentation code.

### SPA navigation (automatic, framework-agnostic)

SPA route changes are **auto-detected** via the browser's [Navigation API](https://developer.mozilla.org/en-US/docs/Web/API/Navigation_API). The SDK registers a single `navigate` listener on `initStrada()` that fires on every client-side navigation regardless of framework — Next.js App Router, React Router, TanStack Router, Vue Router, SvelteKit, and any other SPA router.

```
navigation.addEventListener('navigate', ...) // fires on every SPA route change
```

No framework plugins or manual calls needed. The listener:
- Ends the current pageview span
- Starts a new pageview span for the new path
- Skips cross-origin navigations, reloads, and hash-only changes

Each navigation span carries two extra attributes:

| Span attribute | Values | Description |
|---|---|---|
| `navigation.type` | `"push"`, `"replace"`, `"traverse"` | How the navigation was triggered |
| `navigation.user_initiated` | `true` / `false` | Whether the user clicked a link vs programmatic nav |

**Browser support:** Navigation API is Baseline since January 2026 (Chrome, Edge, Firefox, Safari). For older browsers, the initial pageview span still works; SPA navigations simply won't cycle the span.

If you need to manually trigger a pageview cycle (e.g. for custom routing logic not using the History API), the lower-level API is still available:

```typescript
import { startPageSpan, endCurrentPageSpan } from '@strada.sh/sdk/browser'

// on route change
endCurrentPageSpan()
startPageSpan(newPath)
```

---

## Custom events API

```typescript
import { strada } from '@strada/browser'

// Simple event
strada.track('button_click')

// Event with properties
strada.track('form_submit', {
  form: 'signup',
  plan: 'pro',
  variant: 'hero-cta',
})

// Set the user cookie once after login.
document.cookie = `strada_uid=${encodeURIComponent('user_123')}; Path=/; SameSite=Lax; Secure`

// Later events automatically include user.id.
strada.track('billing_opened', {
  plan: 'pro',
})
```

`strada.track()` emits a log record via the OTel Logs API. The log record lands in `otel_logs` with `event.name` set to the event name. Context (`session.id`, `url.full`, `user.id`) is injected automatically. If a pageview span is currently open, `TraceId` and `SpanId` are attached too. Browser auto-instrumented spans also inherit that pageview as parent unless some other span is already active. Developers only pass event-specific properties.

Under the hood:

```typescript
logger.emit({
  severityNumber: 9,  // INFO
  body: 'button_click',
  attributes: {
    'event.name': 'form_submit',
    'session.id': currentSessionId,
    'url.path': window.location.pathname,
    'url.full': window.location.href,
    'user.id': currentUserId,
    'custom.form': 'signup',
    'custom.plan': 'pro',
  },
})
```

The log record is automatically correlated with the active pageview span via `TraceId` and `SpanId` when one is active. Custom events are queried from `otel_logs`, not `otel_traces`. Each dashboard widget runs its own query against one table, so no joins needed.

### Backend custom events

The same pattern works on the backend. When you emit a log inside an active span's context, the OTel SDK automatically stamps the log record with the span's `TraceId` and `SpanId`. No extra code needed.

```typescript
// Node.js backend
import { logs } from '@opentelemetry/api-logs'

const logger = logs.getLogger('my-api')

app.post('/api/checkout', async (req, res) => {
  // The active span is auto-created by the OTel HTTP instrumentation.
  // This log automatically inherits the span's TraceId + SpanId.
  logger.emit({
    body: 'purchase',
    attributes: {
      'event.name': 'purchase',
      'user.id': req.user.id,
      'custom.plan': req.body.plan,
      'custom.amount': String(req.body.amount),
    },
  })
  // ...handle checkout
})
```

The log record lands in `otel_logs` with `ServiceName = "my-api"` (the backend service name). The `user.id` attribute ties it to the same user as browser events. If the browser sends the `traceparent` header, the backend log shares the same request trace as the incoming browser request:

```
Browser request trace (TraceId = abc123)
+-- fetch POST /api/checkout  (traceparent: abc123)
        |
        v
Backend (TraceId = abc123)
+-- span: POST /api/checkout
    +-- log: "purchase" event  (TraceId = abc123, user.id = "user_123")
```

This means you can query all custom events for a user across browser and backend in a single query. The `ServiceName` column tells you the origin:

```sql
SELECT
  Timestamp,
  ServiceName,                          -- 'my-app' (browser) or 'my-api' (backend)
  LogAttributes['event.name'] AS event,
  LogAttributes['url.path'] AS path,
  TraceId,
  LogAttributes
FROM otel_logs
WHERE LogAttributes['user.id'] = {user_id:String}
  AND LogAttributes['event.name'] != ''
ORDER BY Timestamp ASC
```

No schema changes needed. The `otel_logs` table already has `TraceId`, `SpanId`, `ServiceName`, and bloom filter indexes on `LogAttributes` keys/values.

---

## SDK initialization

```typescript
import { initStrada } from '@strada/browser'

initStrada({
  endpoint: 'https://acme-ingest.strada.sh',
  service: 'my-app',
  version: '1.4.2',

  // optional
  userId: () => window.__user?.id,       // dynamic user ID resolver
  debug: false,
})
```

The SDK:
1. Generates or restores `session.id` from `sessionStorage`
2. Initializes `WebTracerProvider` with `BatchSpanProcessor`
3. Registers `@opentelemetry/auto-instrumentations-web`
4. Attaches a span processor that injects `session.id` and `user.id` onto every span
5. Starts the first pageview span

---

## Materialized views for dashboard queries

Raw `otel_traces` contains every span: backend API calls, database queries, browser fetch requests, resource loads, etc. For a dashboard showing "pageviews per day" or "top browsers", scanning the full traces table is wasteful. Most rows are not pageviews.

Two materialized views fire automatically on every insert to `otel_traces` and pre-aggregate only the pageview spans into compact tables. This is the same pattern used by [Tinybird's web analytics starter kit](https://github.com/tinybirdco/web-analytics-starter-kit).

### Why AggregatingMergeTree

A flat MergeTree storing one row per pageview would save some storage (no Map columns, no Events arrays). But an `AggregatingMergeTree` that pre-computes `uniqState(session_id)` and `countState()` is **~100x more compact**. For a site with 1M pageviews/day, the pages MV might store ~5k-50k aggregated rows per day (one per unique combination of date + pathname + device + browser + country). The sessions MV stores one row per session per day (~100k rows for 100k daily sessions), still way less than 1M raw pageview rows.

### Why two MVs instead of one

ClickHouse AggregatingMergeTree sorting keys determine which rows merge together and which queries are fast. **You can't optimize for both `pathname` and `session_id` in the same sorting key.** A query grouping by pathname needs pathname early in the sort key; a query computing bounce rate needs session_id early. So we split into two tables:

| MV | Powers | Sorting key |
|---|---|---|
| `otel_analytics_pages` | Top pages, browsers, devices, countries, languages, referrers, pageview histogram | `ProjectId, ServiceName, Domain, Date, Pathname` |
| `otel_analytics_sessions` | Bounce rate, avg session duration, unique visitors, realtime visitors | `ProjectId, ServiceName, Domain, Date, SessionId` |

### `otel_analytics_pages`

Pre-aggregates pageview counts and unique sessions by page, device, browser, country, language, referrer, and **domain** (the host the user is visiting).

```sql
-- Schema (AggregatingMergeTree)
ProjectId       LowCardinality(String)
Date            Date
ServiceName     LowCardinality(String)
Domain          String                     -- extracted from url.full with domainWithoutWWW()
Pathname        String
Referrer        String                     -- domainWithoutWWW(http.request.header.referer)
Device          LowCardinality(String)     -- 'desktop', 'mobile-android', 'mobile-ios', 'bot'
Browser         LowCardinality(String)     -- 'chrome', 'firefox', 'safari', 'opera', 'ie', 'Unknown'
Country         LowCardinality(String)     -- ISO 3166-1 alpha-2 from geo.country
Language        LowCardinality(String)     -- from browser.language
Visits          AggregateFunction(uniq, String)    -- uniqState(session_id)
Hits            AggregateFunction(count, UInt64)   -- countState()
```

**Sorting key:** `ProjectId, ServiceName, Domain, Date, Device, Browser, Country, Pathname`

`Domain` is early in the sorting key because multi-domain projects (e.g. `acme.com` + `docs.acme.com`) always filter by domain first. Extracted from `url.full` using `domainWithoutWWW()` in the MV pipe, so the SDK doesn't need to set it explicitly.

The MV pipe extracts flat fields from `SpanAttributes` and `ResourceAttributes`, classifies device/browser from `user_agent.original` using regex (same approach as Tinybird starter kit), and feeds the result into `uniqState`/`countState` aggregates.

**Browser/device classification SQL** (runs inside the MV pipe):

```sql
CASE
  WHEN match(ua, 'wget|ahrefsbot|curl|urllib|bitdiscovery|googlebot') THEN 'bot'
  WHEN match(ua, 'android') THEN 'mobile-android'
  WHEN match(ua, 'ipad|iphone|ipod') THEN 'mobile-ios'
  ELSE 'desktop'
END AS Device,
CASE
  WHEN match(ua, 'firefox') THEN 'firefox'
  WHEN match(ua, 'chrome|crios') THEN 'chrome'
  WHEN match(ua, 'opera') THEN 'opera'
  WHEN match(ua, 'msie|trident') THEN 'ie'
  WHEN match(ua, 'iphone|ipad|safari') THEN 'safari'
  ELSE 'Unknown'
END AS Browser
```

Where `ua` is `lower(coalesce(nullIf(SpanAttributes['user_agent.original'], ''), ResourceAttributes['user_agent.original']))`. The collector injects `user_agent.original` into span attributes from the `User-Agent` request header; the fallback reads the resource attribute set by the browser detector.

### `otel_analytics_sessions`

Pre-aggregates per-session metrics for computing bounce rate and avg session duration.

```sql
-- Schema (AggregatingMergeTree)
ProjectId       LowCardinality(String)
Date            Date
ServiceName     LowCardinality(String)
Domain          String
SessionId       String
Device          SimpleAggregateFunction(any, LowCardinality(String))
Browser         SimpleAggregateFunction(any, LowCardinality(String))
Country         SimpleAggregateFunction(any, LowCardinality(String))
FirstHit        SimpleAggregateFunction(min, DateTime)
LatestHit       SimpleAggregateFunction(max, DateTime)
Hits            AggregateFunction(count, UInt64)
```

**Sorting key:** `ProjectId, ServiceName, Domain, Date, SessionId`

`Device`, `Browser`, `Country` use `SimpleAggregateFunction(any, ...)` because they're constant for a given session. We just need any value, not an aggregate.

**Bounce rate** = sessions where `FirstHit = LatestHit` (only one pageview in the session).
**Avg session duration** = `avg(LatestHit - FirstHit)`.

### Retention

Both MV tables can have their own TTL independent of `otel_traces`:

```sql
-- Analytics MVs: 90-day retention
ENGINE_TTL Date + INTERVAL 90 DAY

-- Raw traces: 7-day retention (or whatever the user configures)
```

This means the analytics dashboard shows 90 days of data while raw traces (with their large Map columns, Events arrays, Links arrays) are cleaned up after 7 days. The storage overhead of 90 days of pre-aggregated analytics data is minimal (a few MB vs GB of raw traces).

---

## Dashboard queries

All dashboard queries read from the materialized views, not from `otel_traces`. They use `uniqMerge(Visits)` and `countMerge(Hits)` to combine the pre-aggregated states.

Every query filters by `ServiceName` and `Domain`. In a multi-domain project (e.g. `acme.com` + `docs.acme.com`), the user selects which domain to view. If the project has only one domain, the UI can auto-select it.

### KPIs: pageviews + unique visitors over time

Daily timeseries for the main dashboard chart. Includes optional previous-period comparison for showing growth percentages.

```sql
-- Current period
WITH
  toDate({date_from:String}) AS current_start,
  toDate({date_to:String}) AS current_end
SELECT
  Date AS day,
  countMerge(Hits) AS pageviews,
  uniqMerge(Visits) AS unique_visitors
FROM otel_analytics_pages
WHERE
  ServiceName = {service:String}
  AND Domain = {domain:String}
  AND Date >= current_start
  AND Date <= current_end
GROUP BY day
ORDER BY day
```

```sql
-- Previous period (same duration, shifted back)
WITH
  toDate({date_from:String}) AS current_start,
  toDate({date_to:String}) AS current_end,
  dateDiff('day', current_start, current_end) + 1 AS period_days
SELECT
  Date + period_days AS day,   -- align to current period for comparison
  countMerge(Hits) AS pageviews,
  uniqMerge(Visits) AS unique_visitors
FROM otel_analytics_pages
WHERE
  ServiceName = {service:String}
  AND Domain = {domain:String}
  AND Date >= current_start - period_days
  AND Date < current_start
GROUP BY day
ORDER BY day
```

### Bounce rate + avg session duration over time

```sql
WITH
  toDate({date_from:String}) AS current_start,
  toDate({date_to:String}) AS current_end
SELECT
  Date AS day,
  uniq(SessionId) AS sessions,
  countMerge(Hits) AS total_pageviews,
  sumIf(1, LatestHit = FirstHit) / uniq(SessionId) AS bounce_rate,
  avg(LatestHit - FirstHit) AS avg_session_duration_sec
FROM otel_analytics_sessions
WHERE
  ServiceName = {service:String}
  AND Domain = {domain:String}
  AND Date >= current_start
  AND Date <= current_end
GROUP BY day
ORDER BY day
```

### KPI summary cards (single row)

One row with totals for the selected period, used for the big number cards at the top of the dashboard.

```sql
WITH
  toDate({date_from:String}) AS current_start,
  toDate({date_to:String}) AS current_end
SELECT
  uniqMerge(Visits) AS unique_visitors,
  countMerge(Hits) AS total_pageviews
FROM otel_analytics_pages
WHERE
  ServiceName = {service:String}
  AND Domain = {domain:String}
  AND Date >= current_start
  AND Date <= current_end
```

```sql
-- Session-based KPIs (bounce rate, avg duration)
WITH
  toDate({date_from:String}) AS current_start,
  toDate({date_to:String}) AS current_end
SELECT
  uniq(SessionId) AS total_sessions,
  sumIf(1, LatestHit = FirstHit) / uniq(SessionId) AS bounce_rate,
  avg(LatestHit - FirstHit) AS avg_session_duration_sec
FROM otel_analytics_sessions
WHERE
  ServiceName = {service:String}
  AND Domain = {domain:String}
  AND Date >= current_start
  AND Date <= current_end
```

### Top pages

```sql
WITH
  toDate({date_from:String}) AS current_start,
  toDate({date_to:String}) AS current_end
SELECT
  Pathname,
  countMerge(Hits) AS pageviews,
  uniqMerge(Visits) AS unique_visitors
FROM otel_analytics_pages
WHERE
  ServiceName = {service:String}
  AND Domain = {domain:String}
  AND Date >= current_start
  AND Date <= current_end
GROUP BY Pathname
ORDER BY pageviews DESC
LIMIT {limit:UInt32}
OFFSET {offset:UInt32}
```

### Top countries

```sql
WITH
  toDate({date_from:String}) AS current_start,
  toDate({date_to:String}) AS current_end
SELECT
  Country,
  uniqMerge(Visits) AS unique_visitors,
  countMerge(Hits) AS pageviews
FROM otel_analytics_pages
WHERE
  ServiceName = {service:String}
  AND Domain = {domain:String}
  AND Date >= current_start
  AND Date <= current_end
GROUP BY Country
ORDER BY unique_visitors DESC
LIMIT {limit:UInt32}
OFFSET {offset:UInt32}
```

### Top browsers

```sql
WITH
  toDate({date_from:String}) AS current_start,
  toDate({date_to:String}) AS current_end
SELECT
  Browser,
  uniqMerge(Visits) AS unique_visitors,
  countMerge(Hits) AS pageviews
FROM otel_analytics_pages
WHERE
  ServiceName = {service:String}
  AND Domain = {domain:String}
  AND Date >= current_start
  AND Date <= current_end
GROUP BY Browser
ORDER BY unique_visitors DESC
LIMIT {limit:UInt32}
```

### Top devices

```sql
WITH
  toDate({date_from:String}) AS current_start,
  toDate({date_to:String}) AS current_end
SELECT
  Device,
  uniqMerge(Visits) AS unique_visitors,
  countMerge(Hits) AS pageviews
FROM otel_analytics_pages
WHERE
  ServiceName = {service:String}
  AND Domain = {domain:String}
  AND Date >= current_start
  AND Date <= current_end
GROUP BY Device
ORDER BY unique_visitors DESC
LIMIT {limit:UInt32}
```

### Top referrers (traffic sources)

```sql
WITH
  toDate({date_from:String}) AS current_start,
  toDate({date_to:String}) AS current_end
SELECT
  Referrer,
  uniqMerge(Visits) AS unique_visitors,
  countMerge(Hits) AS pageviews
FROM otel_analytics_pages
WHERE
  ServiceName = {service:String}
  AND Domain = {domain:String}
  AND Date >= current_start
  AND Date <= current_end
  AND Referrer != ''
  AND Referrer != {domain:String}   -- exclude self-referrals
GROUP BY Referrer
ORDER BY unique_visitors DESC
LIMIT {limit:UInt32}
```

### Top languages

```sql
WITH
  toDate({date_from:String}) AS current_start,
  toDate({date_to:String}) AS current_end
SELECT
  Language,
  uniqMerge(Visits) AS unique_visitors,
  countMerge(Hits) AS pageviews
FROM otel_analytics_pages
WHERE
  ServiceName = {service:String}
  AND Domain = {domain:String}
  AND Date >= current_start
  AND Date <= current_end
GROUP BY Language
ORDER BY unique_visitors DESC
LIMIT {limit:UInt32}
```

### Realtime visitors (last 5 minutes)

Hits `otel_traces` directly because the MVs aggregate by day, not by minute:

```sql
SELECT uniq(SpanAttributes['session.id']) AS active_visitors
FROM otel_traces
WHERE
  ServiceName = {service:String}
  AND SpanName = 'pageview'
  AND Timestamp >= now() - INTERVAL 5 MINUTE
```

### Realtime trend (last 30 minutes, per-minute)

```sql
WITH
  (now() - INTERVAL 30 MINUTE) AS window_start
SELECT
  toStartOfMinute(Timestamp) AS minute,
  uniq(SpanAttributes['session.id']) AS visitors
FROM otel_traces
WHERE
  ServiceName = {service:String}
  AND SpanName = 'pageview'
  AND Timestamp >= window_start
GROUP BY minute
ORDER BY minute
```

---

## Queries that use `otel_traces` directly

Some analytics queries need the full span tree and can't be answered from the pre-aggregated MVs. These are less frequent (user clicks into a specific session, or runs a funnel report) so scanning `otel_traces` is acceptable.

### Page path timeline for a specific user

Shows every page a specific user visited, in order, with time spent on each page.

```sql
SELECT
  Timestamp,
  SpanAttributes['url.path'] AS path,
  SpanAttributes['url.full'] AS full_url,
  Duration / 1e9 AS time_on_page_sec,
  SpanAttributes['session.id'] AS session_id,
  SpanAttributes['http.request.header.referer'] AS referrer
FROM otel_traces
WHERE
  ServiceName = {service:String}
  AND SpanName = 'pageview'
  AND SpanAttributes['user.id'] = {user_id:String}
ORDER BY Timestamp ASC
```

### Page path timeline for a specific session

Same as above but scoped to a single session. Shows the full browsing journey in one tab.

```sql
SELECT
  Timestamp,
  SpanAttributes['url.path'] AS path,
  Duration / 1e9 AS time_on_page_sec
FROM otel_traces
WHERE
  ServiceName = {service:String}
  AND SpanName = 'pageview'
  AND SpanAttributes['session.id'] = {session_id:String}
ORDER BY Timestamp ASC
```

### Session replay (trace spans for one session)

All browser spans for a session: pageviews, fetch calls, resource loads, clicks.

```sql
SELECT
  Timestamp,
  SpanName,
  SpanKind,
  SpanAttributes['url.path'] AS path,
  Duration / 1e6 AS duration_ms,
  SpanAttributes
FROM otel_traces
WHERE SpanAttributes['session.id'] = {session_id:String}
ORDER BY Timestamp ASC
```

### Pageview-only funnel analysis

For funnels that only involve page paths (no custom events):

```sql
WITH sessions AS (
  SELECT
    SpanAttributes['session.id'] AS session_id,
    groupArray(SpanAttributes['url.path']) AS pages
  FROM otel_traces
  WHERE
    ServiceName = {service:String}
    AND SpanName = 'pageview'
    AND Timestamp >= toDate({date_from:String})
    AND Timestamp <= toDate({date_to:String}) + 1
  GROUP BY session_id
)
SELECT
  count()                                                                    AS total_sessions,
  countIf(has(pages, '/pricing'))                                            AS step_1_pricing,
  countIf(has(pages, '/pricing') AND has(pages, '/checkout'))                AS step_2_checkout,
  countIf(has(pages, '/pricing') AND has(pages, '/checkout')
          AND has(pages, '/success'))                                         AS step_3_success
FROM sessions
```

For funnels mixing pageviews and custom events, see the UNION ALL query in the "Custom event queries" section.

### List domains for a project

Useful for the domain selector dropdown in the dashboard.

```sql
SELECT
  Domain,
  countMerge(Hits) AS total_pageviews,
  min(Date) AS first_seen,
  max(Date) AS last_seen
FROM otel_analytics_pages
WHERE ServiceName = {service:String}
GROUP BY Domain
ORDER BY total_pageviews DESC
```

---

## Custom event queries (from `otel_logs`)

Custom events sent via `strada.track()` land in `otel_logs`. Each event is a log record with `EventName` set to the event name and context attributes (`session.id`, `url.path`, `user.id`) injected by the SDK. Each dashboard widget queries `otel_logs` independently; no joins with `otel_traces` needed.

### Custom event histogram (top events)

```sql
SELECT
  LogAttributes['event.name'] AS event,
  count() AS occurrences,
  uniqExact(LogAttributes['session.id']) AS unique_sessions
FROM otel_logs
WHERE
  ServiceName = {service:String}
  AND LogAttributes['event.name'] != ''
  AND Timestamp >= toDate({date_from:String})
  AND Timestamp <= toDate({date_to:String}) + 1
GROUP BY event
ORDER BY occurrences DESC
LIMIT {limit:UInt32}
```

### Custom event timeseries

```sql
SELECT
  toDate(Timestamp) AS day,
  LogAttributes['event.name'] AS event,
  count() AS occurrences
FROM otel_logs
WHERE
  ServiceName = {service:String}
  AND LogAttributes['event.name'] != ''
  AND Timestamp >= toDate({date_from:String})
  AND Timestamp <= toDate({date_to:String}) + 1
GROUP BY day, event
ORDER BY day, occurrences DESC
```

### Custom events for a specific user

All events a specific user triggered, ordered by time. Shows the full user journey across sessions.

```sql
SELECT
  Timestamp,
  LogAttributes['event.name'] AS event,
  LogAttributes['session.id'] AS session_id,
  LogAttributes['url.path'] AS path,
  LogAttributes['user.id'] AS user_id,
  LogAttributes
FROM otel_logs
WHERE
  ServiceName = {service:String}
  AND LogAttributes['user.id'] = {user_id:String}
  AND LogAttributes['event.name'] != ''
ORDER BY Timestamp ASC
```

### Custom events for a specific session

```sql
SELECT
  Timestamp,
  LogAttributes['event.name'] AS event,
  LogAttributes['url.path'] AS path,
  LogAttributes
FROM otel_logs
WHERE
  ServiceName = {service:String}
  AND LogAttributes['session.id'] = {session_id:String}
  AND LogAttributes['event.name'] != ''
ORDER BY Timestamp ASC
```

### Custom event breakdown by property

For a specific event, show the distribution of a custom property. For example, "which plans did users select when submitting the signup form?"

```sql
SELECT
  LogAttributes['custom.plan'] AS plan,
  count() AS occurrences,
  uniqExact(LogAttributes['user.id']) AS unique_users
FROM otel_logs
WHERE
  ServiceName = {service:String}
  AND LogAttributes['event.name'] = 'form_submit'
  AND Timestamp >= toDate({date_from:String})
  AND Timestamp <= toDate({date_to:String}) + 1
GROUP BY plan
ORDER BY occurrences DESC
```

### Full user activity timeline (pageviews + custom events)

When you need to see a user's complete journey (both pages visited and events triggered), combine both tables with UNION ALL:

```sql
SELECT * FROM (
  SELECT
    Timestamp,
    'pageview' AS type,
    SpanAttributes['url.path'] AS name,
    SpanAttributes['session.id'] AS session_id,
    Duration / 1e9 AS duration_sec,
    SpanAttributes AS properties
  FROM otel_traces
  WHERE
    ServiceName = {service:String}
    AND SpanName = 'pageview'
    AND SpanAttributes['user.id'] = {user_id:String}

  UNION ALL

  SELECT
    Timestamp,
    'event' AS type,
    LogAttributes['event.name'] AS name,
    LogAttributes['session.id'] AS session_id,
    0 AS duration_sec,
    LogAttributes AS properties
  FROM otel_logs
  WHERE
    ServiceName = {service:String}
    AND LogAttributes['user.id'] = {user_id:String}
    AND LogAttributes['event.name'] != ''
)
ORDER BY Timestamp ASC
```

### Funnel analysis (pageviews + custom events)

For funnels that mix pageviews and custom events (e.g. "visited /pricing -> clicked 'start_trial' -> submitted 'signup_form'"), collect events per session from both tables:

```sql
WITH events AS (
  SELECT
    SpanAttributes['session.id'] AS session_id,
    SpanAttributes['url.path'] AS event_name
  FROM otel_traces
  WHERE ServiceName = {service:String} AND SpanName = 'pageview'
    AND Timestamp >= toDate({date_from:String})
    AND Timestamp <= toDate({date_to:String}) + 1

  UNION ALL

  SELECT
    LogAttributes['session.id'] AS session_id,
    LogAttributes['event.name'] AS event_name
  FROM otel_logs
  WHERE ServiceName = {service:String} AND LogAttributes['event.name'] != ''
    AND Timestamp >= toDate({date_from:String})
    AND Timestamp <= toDate({date_to:String}) + 1
),
sessions AS (
  SELECT session_id, groupArray(event_name) AS events
  FROM events
  GROUP BY session_id
)
SELECT
  count() AS total_sessions,
  countIf(has(events, '/pricing'))                                            AS step_1_pricing,
  countIf(has(events, '/pricing') AND has(events, 'start_trial'))             AS step_2_start_trial,
  countIf(has(events, '/pricing') AND has(events, 'start_trial')
          AND has(events, 'signup_form'))                                      AS step_3_signup
FROM sessions
```

---

## Why logs for custom events?

OTel is **deprecating `span.addEvent()`** (targeted March 2026) in favor of the Logs API for events. Using logs for custom analytics events aligns with the OTel direction.

**Practical benefits:**

- Each dashboard widget queries one table. Pageview widgets query MVs or `otel_traces`. Custom event widgets query `otel_logs`. No joins for the common case.
- Log records are lighter than spans (no duration, no status, no events/links arrays). Less storage per custom event.
- `otel_logs` already has bloom filter indexes on `LogAttributes` keys and values, so filtering by `event.name`, `session.id`, or `user.id` is efficient.
- Context propagation still works: `TraceId` and `SpanId` on the log record link it back to the active pageview span, so you can correlate if needed.

**When you do need to combine both:** for user timelines and funnels that mix pageviews and custom events, use `UNION ALL` as shown in the queries above. This is the advanced case, not the common dashboard path.

---

## Implementation checklist

### Collector changes (minimal)

- [x] Read `CF-IPCountry` header and inject as `geo.country` in span_attributes of every trace row
- [x] Read `User-Agent` header and inject as `user_agent.original` in span_attributes (fallback for when the browser detector doesn't set it as a resource attribute)
- [x] Both are general enrichments, not analytics-specific

### New Tinybird datasources

- [x] `tinybird/datasources/otel_analytics_pages.datasource` (AggregatingMergeTree)
- [x] `tinybird/datasources/otel_analytics_sessions.datasource` (AggregatingMergeTree)

### New Tinybird materializations

- [x] `tinybird/materializations/otel_analytics_pages_mv.pipe` (fires on insert to `otel_traces`, WHERE SpanName = 'pageview')
- [x] `tinybird/materializations/otel_analytics_sessions_mv.pipe` (fires on insert to `otel_traces`, WHERE SpanName = 'pageview')

### ClickHouse DDL (self-hosted)

- [x] Add `otel_analytics_pages` table + MV to `clickhouse.sql`
- [x] Add `otel_analytics_sessions` table + MV to `clickhouse.sql`

### JWT scopes

- [ ] Add `otel_analytics_pages` and `otel_analytics_sessions` to the JWT `scopes` array with `ProjectId` filter (same pattern as other tables)
