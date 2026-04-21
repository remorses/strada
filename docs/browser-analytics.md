# Browser Analytics

Strada supports web analytics via standard OpenTelemetry. The browser SDK sends OTLP traces to the same collector used for backend observability — no separate pipeline, no separate schema.

## Core model

Everything is a **span** inside `otel_traces`. No separate analytics tables needed.

```
otel_traces
└── session trace  (TraceId = session boundary)
    ├── span: pageview "/"
    │   ├── span: fetch GET /api/user
    │   └── span: button_click "cta-hero"   ← custom event
    ├── span: pageview "/pricing"
    │   └── span: form_submit "signup"       ← custom event
    └── span: pageview "/dashboard"
```

- **Session** = one `TraceId`, stored in `sessionStorage` (per-tab, survives page refreshes, cleared on tab close)
- **Pageview** = a span that starts on navigation and ends when the user navigates away or closes the tab
- **Custom event** = an instant zero-duration child span of the current pageview span
- **Auto-instrumented events** (fetch, XHR, clicks) = standard OTel child spans, automatically nested

This means funnels, session replays, and custom event histograms all query `otel_traces` with no joins.

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
- `session.id` is NOT a user identifier — it is a visit identifier
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
  "browser.language": "en-US"
}
```

These come from `@opentelemetry/opentelemetry-browser-detector` automatically.

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

`geo.country` is injected server-side by the Strada collector from the `CF-IPCountry` Cloudflare header — no client-side geolocation needed.

### Custom event span

```json
{
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "e9d23c3e9d0f7a3c",
  "parentSpanId": "00f067aa0ba902b7",
  "name": "button_click",
  "kind": "INTERNAL",
  "startTimeUnixNano": "1711541840000000000",
  "endTimeUnixNano": "1711541840000000000",
  "attributes": {
    "session.id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "url.full": "https://app.acme.com/pricing",
    "user.id": "user_123",
    "custom.element": "cta-hero",
    "custom.text": "Start free trial",
    "custom.plan": "pro"
  }
}
```

- `parentSpanId` points to the current pageview span — nesting is automatic via OTel context propagation
- `custom.*` prefix isolates user properties from standard OTel attributes
- Duration is 0 — custom events are instants, not operations

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

This span is created automatically by `@opentelemetry/instrumentation-fetch`. The `session.id` is injected by a custom span processor that enriches every span.

---

## Auto-instrumentation

The Strada browser SDK wraps `@opentelemetry/auto-instrumentations-web`, which instruments 4 things automatically with zero code changes:

| Package | What it captures |
|---|---|
| `instrumentation-document-load` | Full page load waterfall: navigation timing, each resource (JS, CSS, images) as child spans |
| `instrumentation-fetch` | Every `fetch()` call → span with method, URL, status code, duration |
| `instrumentation-xml-http-request` | Every XHR call (Axios, legacy libs) → same as fetch |
| `instrumentation-user-interaction` | Click events → span per click, named after the element |

### What you get for free on page load

```
span: documentLoad "/"             [0ms → 1240ms]
├── span: resourceFetch "main.js"  [45ms → 320ms]
├── span: resourceFetch "app.css"  [45ms → 180ms]
└── span: fetchRequest "GET /api"  [800ms → 1100ms]
```

This is already Core Web Vitals territory — you can see slow resource loads and blocking API calls per pageview without writing a line of instrumentation code.

### SPA navigation (manual, framework-specific)

SPA route changes are NOT auto-instrumented because they don't trigger actual HTTP requests. The Strada SDK provides a router integration:

```typescript
// Next.js (App Router)
import { StradaNextPlugin } from '@strada/browser/next'

// React Router
import { StradaRouterPlugin } from '@strada/browser/react-router'
```

Under the hood these hooks call:

```typescript
// on route change
stradaSDK.endCurrentPageSpan()
stradaSDK.startPageSpan(newPath)
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

// Event with user context
strada.identify('user_123', {
  email: 'tommy@acme.com',
  plan: 'pro',
})
```

`strada.track()` creates an instant child span of the current active pageview span. All standard context (`session.id`, `url.full`, `user.id`) is injected automatically — developers only pass event-specific properties.

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

## Analytics queries

All queries run against `otel_traces` on `SpanName`, `SpanAttributes`, and `ResourceAttributes`.

### Pageview histogram

```sql
SELECT
  toDate(Timestamp) AS day,
  count() AS pageviews,
  uniqExact(SpanAttributes['session.id']) AS sessions
FROM otel_traces
WHERE
  ServiceName = 'my-app'
  AND SpanName = 'pageview'
  AND Timestamp >= now() - INTERVAL 30 DAY
GROUP BY day
ORDER BY day
```

### Top pages

```sql
SELECT
  SpanAttributes['url.path'] AS path,
  count() AS views,
  uniqExact(SpanAttributes['session.id']) AS sessions,
  avg(Duration) / 1e9 AS avg_time_on_page_sec
FROM otel_traces
WHERE ServiceName = 'my-app' AND SpanName = 'pageview'
GROUP BY path
ORDER BY views DESC
LIMIT 20
```

### Top countries

```sql
SELECT
  SpanAttributes['geo.country'] AS country,
  uniqExact(SpanAttributes['session.id']) AS sessions
FROM otel_traces
WHERE ServiceName = 'my-app' AND SpanName = 'pageview'
GROUP BY country
ORDER BY sessions DESC
```

### Top browsers

```sql
SELECT
  ResourceAttributes['browser.platform'] AS platform,
  ResourceAttributes['browser.mobile'] AS mobile,
  uniqExact(SpanAttributes['session.id']) AS sessions
FROM otel_traces
WHERE ServiceName = 'my-app' AND SpanName = 'pageview'
GROUP BY platform, mobile
ORDER BY sessions DESC
```

### Custom event histogram

```sql
SELECT
  SpanName AS event,
  count() AS occurrences,
  uniqExact(SpanAttributes['session.id']) AS unique_sessions
FROM otel_traces
WHERE
  ServiceName = 'my-app'
  AND SpanName NOT IN ('pageview', 'documentLoad', 'resourceFetch')
  AND SpanKind = 'INTERNAL'
  AND Duration = 0
GROUP BY event
ORDER BY occurrences DESC
```

### Funnel analysis

```sql
-- How many sessions went /pricing → /checkout → /success
WITH sessions AS (
  SELECT
    SpanAttributes['session.id'] AS session_id,
    groupArray(SpanAttributes['url.path']) AS pages
  FROM otel_traces
  WHERE ServiceName = 'my-app' AND SpanName = 'pageview'
  GROUP BY session_id
)
SELECT
  countIf(has(pages, '/pricing'))                                          AS step_1_pricing,
  countIf(has(pages, '/pricing') AND has(pages, '/checkout'))              AS step_2_checkout,
  countIf(has(pages, '/pricing') AND has(pages, '/checkout')
          AND has(pages, '/success'))                                       AS step_3_success
FROM sessions
```

### Session replay (ordered events for one session)

```sql
SELECT
  Timestamp,
  SpanName,
  SpanAttributes['url.path'] AS path,
  Duration / 1e6 AS duration_ms,
  mapKeys(SpanAttributes) AS attr_keys,
  mapValues(SpanAttributes) AS attr_values
FROM otel_traces
WHERE SpanAttributes['session.id'] = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
ORDER BY Timestamp ASC
```

---

## Why not logs for custom events?

OTel is deprecating `span.addEvent()` in favor of the Logs API for new events. However for analytics the **trace model is strictly better** because:

- No `JOIN` between `otel_traces` and `otel_logs` needed in the UI
- Custom events automatically inherit parent context (pageview span, session, URL) via OTel context propagation — no manual attribute copying
- The trace waterfall shows custom events alongside fetch calls and resource loads in the right timeline position
- `GROUP BY SpanName` works uniformly for both pageviews and custom events
- Funnel queries only need one table

Custom events as zero-duration `INTERNAL` spans is fully valid OTel — the deprecation applies specifically to `Span.addEvent()`, not to creating child spans.
