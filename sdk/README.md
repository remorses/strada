# @strada.sh/sdk

**OpenTelemetry-first error tracking, tracing, logs, metrics, and browser analytics for Strada.**

Import from `@strada.sh/sdk` in every runtime. The package uses export conditions so browsers get the browser runtime, Cloudflare Workers get the Workers runtime, and servers get the Node runtime.

```ts
import { initStrada, captureException, trace } from "@strada.sh/sdk"

initStrada({
  service: "api",
  endpoint: "https://my-project-ingest.strada.sh",
  environment: "production",
  version: "1.0.0",
})

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0))
})

try {
  throw new Error("db timeout")
} catch (error) {
  captureException(error, {
    tags: { route: "/checkout" },
  })
}
```

## Use normal OpenTelemetry APIs

After `initStrada()`, the global OTel providers are configured. You can use standard OTel APIs directly.

```ts
import { initStrada, trace, logs, metrics, SeverityNumber } from "@strada.sh/sdk"

initStrada({
  projectId: "my-project",
  service: "worker",
})

const tracer = trace.getTracer("jobs")
const logger = logs.getLogger("jobs")
const meter = metrics.getMeter("jobs")

const counter = meter.createCounter("emails.sent")

const span = tracer.startSpan("send-email")
logger.emit({
  body: "sending email",
  severityText: "INFO",
  severityNumber: SeverityNumber.INFO,
})
counter.add(1)
span.end()
```

## Create traces and spans

Use the standard OTel tracing API after `initStrada()`.

```ts
import { initStrada, trace, SpanStatusCode } from "@strada.sh/sdk"

initStrada({
  projectId: "my-project",
  service: "api",
})

const tracer = trace.getTracer("checkout")

const span = tracer.startSpan("checkout.request", {
  attributes: {
    "checkout.id": "chk_123",
    "enduser.id": "user_123",
  },
})

try {
  span.addEvent("payment.started")
  span.setAttribute("checkout.step", "payment")
  span.setStatus({ code: SpanStatusCode.OK })
} catch (error) {
  if (error instanceof Error) {
    span.recordException(error)
  }
  span.setStatus({ code: SpanStatusCode.ERROR })
  throw error
} finally {
  span.end()
}
```

### Parent and child spans

```ts
import { initStrada, trace, context } from "@strada.sh/sdk"

initStrada({
  projectId: "my-project",
  service: "api",
})

const tracer = trace.getTracer("checkout")

const parentSpan = tracer.startSpan("checkout.request")

await context.with(trace.setSpan(context.active(), parentSpan), async () => {
  const childSpan = tracer.startSpan("db.insert-order")

  try {
    childSpan.setAttribute("db.system", "postgresql")
    childSpan.setAttribute("db.operation", "INSERT")
    // run database work here
  } finally {
    childSpan.end()
  }
})

parentSpan.end()
```

## Emit logs with OpenTelemetry

The standard OTel logs API is `logs.getLogger().emit()`. In most cases, `severityNumber` is enough. `severityText` is optional.

Important: **`console.log()` and other console methods are not sent by default**. The browser SDK exports logs you emit through the OTel logs API, `track()`, `captureException()`, and uncaught browser errors. It does not monkey-patch `console.log`, `console.info`, `console.warn`, or `console.error`.

```ts
import { initStrada, logs, SeverityNumber } from "@strada.sh/sdk"

initStrada({
  projectId: "my-project",
  service: "frontend",
})

const logger = logs.getLogger("app")

logger.emit({
  severityNumber: SeverityNumber.INFO,
  body: "checkout started",
  attributes: {
    "event.name": "checkout_started",
    "enduser.id": "user_123",
    "custom.plan": "pro",
  },
})
```

### Error logs with raw OTel

```ts
import { initStrada, logs, SeverityNumber } from "@strada.sh/sdk"

initStrada({
  projectId: "my-project",
  service: "api",
})

const logger = logs.getLogger("app")

try {
  throw new TypeError("payment failed")
} catch (error) {
  const err = error instanceof Error ? error : new Error(String(error))

  logger.emit({
    severityNumber: SeverityNumber.ERROR,
    body: err.message,
    attributes: {
      "exception.type": err.name,
      "exception.message": err.message,
      "exception.stacktrace": err.stack ?? "",
    },
  })
}
```

### Same thing with Strada helpers

For analytics-style events, prefer `track()` in the browser:

```ts
import { initStrada, track } from "@strada.sh/sdk"

initStrada({
  projectId: "my-project",
  service: "frontend",
})

track("checkout_started", {
  plan: "pro",
  source: "pricing-page",
})
```

For errors, prefer `captureException()` when you want Strada's error conventions:

```ts
import { initStrada, captureException } from "@strada.sh/sdk"

initStrada({
  projectId: "my-project",
  service: "api",
})

try {
  throw new Error("payment failed")
} catch (error) {
  captureException(error, {
    handled: true,
    mechanism: "generic",
  })
}
```

## Identify the current user

The SDK reads the user ID from a **cookie** (`strada_uid` by default). Set this cookie when the user logs in. The browser SDK picks it up automatically on every span, log, error, and custom event.

```ts
initStrada({
  projectId: "my-project",
  service: "frontend",
})

document.cookie = `strada_uid=${encodeURIComponent(user.id)}; Path=/; SameSite=Lax; Secure`
```

The cookie must be **JS-readable** (not `httpOnly`) so the browser SDK can access it via `document.cookie`.

### Setting the cookie from your backend

With better-auth, use the `afterSession` hook or middleware to set the cookie after login:

```ts
// server middleware (runs on every request)
app.use(async (req, res, next) => {
  const session = await auth.api.getSession({ headers: req.headers })
  if (session?.user) {
    res.setHeader("Set-Cookie", `strada_uid=${encodeURIComponent(session.user.id)}; Path=/; SameSite=Lax; Secure; Max-Age=31536000`)
  }
  next()
})
```

### Server-side user identification

For browser-initiated requests, the backend gets `enduser.id` automatically via W3C Baggage. For server-first requests, put the user into baggage in auth middleware using standard OTel `propagation` APIs:

```ts
import { context, propagation } from "@strada.sh/sdk"

app.use(async (req, res, next) => {
  const session = await auth.api.getSession({ headers: req.headers })
  if (!session?.user) return next()

  res.setHeader("Set-Cookie", `strada_uid=${encodeURIComponent(session.user.id)}; Path=/; SameSite=Lax; Secure; Max-Age=31536000`)

  const baggage = propagation.createBaggage({
    "enduser.id": { value: session.user.id },
  })
  const ctx = propagation.setBaggage(context.active(), baggage)

  return context.with(ctx, next)
})
```

That makes `enduser.id` show up in both **server spans** and **server logs** for the current request.

## Browser custom events

In the browser runtime, Strada also exposes `track()` for product analytics style events.

```ts
import { initStrada, track } from "@strada.sh/sdk"

initStrada({
  projectId: "my-project",
  service: "frontend",
})

track("signup_started", {
  plan: "pro",
  source: "hero",
})
```

These events are emitted as **log records**, not spans. Later you can query them from `otel_logs` using `event.name`.

## What it sends

```text
browser / server code
        │
        ├─ traces  ───────────────► /v1/traces
        ├─ logs    ───────────────► /v1/logs
        └─ metrics ───────────────► /v1/metrics
                                   │
                                   ▼
                              Strada collector
                                   │
                 ┌─────────────────┴─────────────────┐
                 ▼                                   ▼
            otel_traces                         otel_logs
```

### Browser spans

The browser runtime adds:

- `session.id` from `sessionStorage`
- `url.path`, `url.query`, `url.full`
- `http.request.header.referer`
- `enduser.id` from `strada_uid` cookie or `StradaOptions.userId`

It also starts a `pageview` span and usually parents later browser work to that pageview when no other span is active.

### Browser custom events

`track("signup_started")` becomes a log record like this:

```json
{
  "body": "signup_started",
  "eventName": "signup_started",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "attributes": {
    "event.name": "signup_started",
    "session.id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "url.path": "/pricing",
    "url.full": "https://app.example.com/pricing",
    "enduser.id": "user_123",
    "custom.plan": "pro",
    "custom.source": "hero"
  },
  "resource": {
    "service.name": "frontend",
    "service.version": "1.0.0"
  }
}
```

### Browser pageview + fetch hierarchy

```text
trace: pageview /pricing
├─ span: pageview
├─ span: fetch GET /api/plans
└─ log: signup_started
```

Important detail: `session.id` is the stable browser session identifier. It is **not** one giant tab-wide `TraceId`.

### Exception logs

`captureException(error)` emits a log record with OTel exception fields.

```json
{
  "body": "payment failed",
  "eventName": "exception",
  "severityText": "ERROR",
  "attributes": {
    "exception.type": "Error",
    "exception.message": "payment failed",
    "exception.stacktrace": "Error: payment failed...",
    "exception.mechanism.type": "generic",
    "exception.mechanism.handled": "true",
    "session.id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "enduser.id": "user_123"
  }
}
```

The collector later extracts these into the `otel_errors` table for grouping and issue views.

## Cloudflare Workers

The Workers runtime is a minimal, opt-in only entry. No automatic instrumentation, no automatic spans. The SDK only sends data when you explicitly call `captureException()`, `trace.getTracer()`, or `logs.getLogger()`. If none of these are called, zero HTTP requests are made to the collector.

This keeps the bundle small and avoids the per-request billing overhead of automatic instrumentation. For automatic instrumentation of KV, D1, Durable Objects, fetch, etc., use Cloudflare's built-in tracing instead (see below).

```ts
import { initStrada, captureException } from "@strada.sh/sdk"

export default {
  fetch(request, env) {
    initStrada({ projectId: env.STRADA_PROJECT_ID, service: "api" })

    try {
      return handleRequest(request)
    } catch (err) {
      captureException(err)
      return new Response("error", { status: 500 })
    }
  },
} satisfies ExportedHandler<Env>
```

Same API as Node. `initStrada()` is safe to call on every request (no-op after the first call). Config comes from `env` bindings since Workers don't have `process.env`.

Manual spans and logs work the same way:

```ts
import { initStrada, trace, logs, SeverityNumber } from "@strada.sh/sdk"

export default {
  fetch(request, env) {
    initStrada({ projectId: env.STRADA_PROJECT_ID, service: "api" })

    const tracer = trace.getTracer("checkout")
    return tracer.startActiveSpan("process-order", async (span) => {
      span.setAttribute("order.id", "ord_123")
      // ...
      span.end()
      return new Response("ok")
    })
  },
} satisfies ExportedHandler<Env>
```

No `flush()`, no `ctx.waitUntil()`, no special imports. The SDK auto-flushes via `waitUntil` from `cloudflare:workers` whenever telemetry is emitted. If nothing is emitted, zero HTTP requests.

### Cloudflare built-in tracing (automatic instrumentation)

For automatic instrumentation, use Cloudflare's built-in tracing. It instruments at the runtime level (KV, D1, Durable Objects, fetch, handler invocations) without any SDK overhead:

```jsonc
// wrangler.jsonc
{
  "observability": {
    "traces": { "enabled": true }
  }
}
```

This works alongside the Strada SDK. Use built-in tracing for automatic spans, and the SDK for error capture, custom events, and manual spans.

### Workers requirements

The Workers entry requires the `nodejs_compat` compatibility flag for `AsyncLocalStorage` context propagation:

```jsonc
// wrangler.jsonc
{
  "compatibility_flags": ["nodejs_compat"]
}
```

## Under the hood

## Root import uses conditions

`@strada.sh/sdk` resolves differently by runtime:

- **browser bundlers** get the browser implementation (WebTracerProvider, session management, pageview spans)
- **Cloudflare Workers** get the Workers implementation (BasicTracerProvider, auto-flush via waitUntil, no automatic spans)
- **Node.js / Bun / Deno** get the server implementation (NodeTracerProvider, process handlers, resource detection)

That means the same import path can configure different OTel SDKs without user changes.

## Exporters, batching, and flush behavior

By default the SDK uses **OTLP HTTP JSON exporters** for every signal:

- **browser traces** → `OTLPTraceExporter` to `/v1/traces`
- **browser logs** → `OTLPLogExporter` to `/v1/logs`
- **Node traces** → `OTLPTraceExporter` to `/v1/traces`
- **Node logs** → `OTLPLogExporter` to `/v1/logs`
- **Node metrics** → `OTLPMetricExporter` to `/v1/metrics`
- **Workers traces** → `OTLPTraceExporter` to `/v1/traces` (auto-flushed via waitUntil)
- **Workers logs** → `OTLPLogExporter` to `/v1/logs` (auto-flushed via waitUntil)

You can tune batching and cadence with `telemetry` in `initStrada()`:

```ts
initStrada({
  projectId: "my-project",
  service: "api",
  telemetry: {
    traces: {
      scheduledDelayMillis: 1000,
      maxExportBatchSize: 128,
      maxQueueSize: 1024,
      exportTimeoutMillis: 10000,
    },
    logs: {
      scheduledDelayMillis: 1000,
      maxExportBatchSize: 128,
    },
    metrics: {
      exportIntervalMillis: 5000,
      exportTimeoutMillis: 3000,
    },
  },
})
```

The SDK intentionally reuses familiar OTel option names:

- `telemetry.traces` uses the same shape as OTel batch span processor browser config
- `telemetry.logs` uses the same shape as OTel batch log record processor browser config
- `telemetry.metrics` uses the same shape as `PeriodicExportingMetricReaderOptions`, minus exporter internals

### Trace and log batching defaults

Spans and logs are not sent one-by-one. They go through the standard OTel batch processors.

Unless you override OTel env vars, the default batch behavior is:

- **scheduled delay**: `5000ms`
- **max export batch size**: `512`
- **max queue size**: `2048`
- **export timeout**: `30000ms`

So in normal operation, ended spans and emitted logs are usually exported within about **5 seconds**, or sooner if the batch fills up.

### Node metrics cadence

Node metrics use `PeriodicExportingMetricReader` with an explicit export interval of **10 seconds** in this SDK.

```text
spans/logs: batched, usually every ~5s
metrics: periodic export every 10s
```

### Manual flush and shutdown

The SDK exposes:

- `flush()` → flush buffered telemetry without tearing down the SDK
- `shutdown()` → flush and shut down the SDK/providers

On **Node.js**:

- `uncaughtException` captures the error, flushes logs + traces + metrics, then exits
- `SIGTERM` / `SIGINT` call `shutdown()`

- `telemetry.metrics` is currently only meaningful on Node.js. Workers do not configure a metric exporter; `metrics.getMeter()` returns a noop on Workers

On **Cloudflare Workers**:

- Auto-flush via `waitUntil` from `cloudflare:workers` whenever telemetry is emitted
- Multiple span ends / log emits in the same microtask share one flush
- If no telemetry is emitted, zero HTTP requests are made
- `flush()` is available for manual use but rarely needed

On the **browser**:

- `flush()` calls `forceFlush()` on the tracer and logger providers
- `shutdown()` removes listeners, ends the current pageview, and shuts down the providers

### Browser page close behavior

The browser SDK relies on the **standard OTel browser batch processor behavior**.

That means:

- pageviews end on `visibilitychange: hidden`
- OTel batch processors **auto flush on document hide by default**
- OTel browser processors also install a **`pagehide` fallback**, mainly for Safari compatibility
- you can turn that off with `telemetry.traces.disableAutoFlushOnDocumentHide` or `telemetry.logs.disableAutoFlushOnDocumentHide`

The browser OTLP HTTP exporter uses `fetch` with **`keepalive: true`** when possible, which improves the chance that an export already in progress can finish during page teardown. But there is still **no hard guarantee** that telemetry buffered in memory right before tab close will be delivered.

Strada does **not** add its own extra unload hook on top of this. It relies on the upstream OTel browser behavior:

- flush on `visibilitychange` when the document becomes hidden
- flush on `pagehide` as a fallback
- export with `fetch(..., { keepalive: true })`

The browser exporter does **not** use `navigator.sendBeacon()` directly in the current installed OTel path.

Practical rule:

- if the batch timer already fired, the data is likely already on the way
- if the user closes the tab immediately after an event, some very recent telemetry may be lost

If this matters for a particular flow, call `flush()` yourself at a controlled boundary.

## Browser-to-server context propagation

The SDK automatically propagates `session.id` and `enduser.id` from the browser to the backend using **W3C Baggage**. Every outgoing `fetch`/`XHR` request from the browser includes both `traceparent` and `baggage` HTTP headers.

```text
Browser                                    Server
session.id = abc                           BaggageSpanProcessor reads baggage:
enduser.id = user_123                        session.id -> span attribute
          |                                  enduser.id -> span attribute
          | fetch POST /api/checkout
          | headers:                       BaggageLogProcessor reads baggage:
          |   traceparent: 00-abc123...      session.id -> log attribute
          |   baggage: strada.session.id=abc,enduser.id=user_123
          v
```

This means backend spans and log records created within a browser-initiated request automatically carry the browser's `session.id` and `enduser.id`. No app code needed.

**What this enables:**

- Backend custom events (emitted via `logs.getLogger().emit()`) are correlated to the browser session
- Errors captured on the backend include the browser session context
- You can query all events for a session across browser and backend in a single SQL query:

```sql
SELECT Timestamp, ServiceName, LogAttributes['event.name'] AS event
FROM otel_logs
WHERE LogAttributes['session.id'] = {session_id:String}
ORDER BY Timestamp ASC
```

**How it works under the hood:**

- The browser SDK registers a `CompositePropagator` with `W3CTraceContextPropagator` + `W3CBaggagePropagator`
- The `PageviewContextManager` injects current baggage (session.id + enduser.id) into the OTel context on every outgoing request
- The Node SDK registers the same composite propagator to extract baggage from incoming requests
- `BaggageSpanProcessor` reads the baggage and sets `session.id` / `enduser.id` as span attributes
- `BaggageLogProcessor` does the same for log records

Baggage updates live. When the `strada_uid` cookie changes, the next outgoing request will carry the updated `enduser.id`.

## Browser runtime

The browser build sets up:

- `WebTracerProvider`
- `LoggerProvider`
- OTLP HTTP exporters for traces and logs
- W3C Baggage propagation for session.id and enduser.id
- global `error` and `unhandledrejection` handlers
- pageview span lifecycle
- SPA navigation detection via the Navigation API
- log filtering for noisy browser junk like `Script error.` and extension frames

## Node runtime

The server build sets up:

- `NodeTracerProvider` for traces with `AsyncLocalStorageContextManager`
- `MeterProvider` for metrics
- `LoggerProvider` for logs
- OTLP HTTP exporters for traces, logs, metrics
- W3C Baggage extraction with `BaggageSpanProcessor` and `BaggageLogProcessor`
- Resource detection (`telemetry.sdk.*`, `process.*`, `host.*`, `OTEL_RESOURCE_ATTRIBUTES`)
- global `uncaughtException` and `unhandledRejection` handlers
- `flush()` and `shutdown()` helpers for graceful process exit

## Workers runtime

The Workers build is minimal and opt-in only:

- `BasicTracerProvider` for traces with `AsyncLocalStorage` context manager (requires `nodejs_compat`)
- `LoggerProvider` for logs
- OTLP HTTP exporters for traces and logs
- W3C Baggage extraction with `BaggageSpanProcessor` and `BaggageLogProcessor`
- Auto-flush via `waitUntil` from `cloudflare:workers` (no manual flush needed)
- `cloud.provider: cloudflare` and `cloud.platform: cloudflare.workers` resource attributes
- No automatic spans, no process handlers
- No metrics provider. `metrics.getMeter()` returns a noop on Workers. Use Cloudflare Analytics Engine or Workers Observability for metrics instead
- Zero HTTP requests to the collector unless user code creates telemetry

## Auto-instrumentation (optional)

The SDK does **not** include auto-instrumentation by default. It only sets up providers, exporters, and error handlers. If you want automatic spans for HTTP requests, database queries, or browser interactions, install the OTel auto-instrumentation packages separately.

### Node auto-instrumentation

Automatically creates spans for outgoing/incoming HTTP requests, database queries (pg, mysql, mongodb, redis), gRPC calls, and more. No code changes needed; it monkey-patches Node.js modules at import time.

```bash
pnpm add @opentelemetry/auto-instrumentations-node
```

```ts
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { registerInstrumentations } from "@opentelemetry/instrumentation"
import { initStrada } from "@strada.sh/sdk"

initStrada({
  projectId: "my-project",
  service: "api",
})

// Call after initStrada() so the global providers are registered
registerInstrumentations({
  instrumentations: [getNodeAutoInstrumentations()],
})
```

This adds spans for `http`, `https`, `fetch`, `express`, `fastify`, `koa`, `pg`, `mysql`, `mongodb`, `redis`, `ioredis`, `grpc`, `graphql`, `aws-sdk`, `fs`, `dns`, `net`, and many more. See the [full list](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/metapackages/auto-instrumentations-node).

### Browser auto-instrumentation

Automatically creates spans for `fetch`, `XMLHttpRequest`, document load timing, and user interactions (clicks, navigation). Useful for seeing how long page loads and API calls take without adding manual spans.

```bash
pnpm add @opentelemetry/auto-instrumentations-web
```

```ts
import { getWebAutoInstrumentations } from "@opentelemetry/auto-instrumentations-web"
import { registerInstrumentations } from "@opentelemetry/instrumentation"
import { initStrada } from "@strada.sh/sdk"

initStrada({
  projectId: "my-project",
  service: "frontend",
})

registerInstrumentations({
  instrumentations: [getWebAutoInstrumentations()],
})
```

This adds spans for:
- **fetch / XHR** — every `fetch()` and `XMLHttpRequest` call becomes a span with URL, method, status code, and duration
- **document load** — spans for DNS, TCP, TLS, request, response, DOM processing, and load event timing
- **user interaction** — spans for click events on interactive elements

### Cloudflare Workers auto-instrumentation

Workers use Cloudflare's **built-in tracing** instead of a JS instrumentation package. It instruments at the runtime level (inside workerd), so it has zero bundle size impact and zero per-request overhead:

```jsonc
// wrangler.jsonc
{
  "observability": {
    "traces": { "enabled": true }
  }
}
```

This auto-instruments KV, D1, Durable Objects, fetch, handler invocations, and more. It supports OTLP export to external backends. Use it alongside the Strada SDK: built-in tracing for automatic spans, the SDK for error capture and custom events.

### Why it's not built in

Auto-instrumentation packages are large. The Node metapackage pulls in ~30 instrumentation libraries, AWS/GCP resource detectors, gRPC bindings, and polyfills, adding **~2MB** to the bundle. The browser package adds **~70kB**. The Workers entry has **no auto-instrumentation at all** since Cloudflare's built-in tracing handles it at the runtime level with zero bundle cost. By keeping auto-instrumentation opt-in, the SDK stays lightweight for users who only need error tracking, custom events, or manual tracing.

## Error handling semantics

`captureException()` always normalizes the input to an `Error`, runs ignore filters, applies `beforeSend`, then emits a log record.

`beforeSend` can:

- return the same `Error`
- return a rewritten `Error`
- return `null` to drop the event

## Query shape later

Custom events are easy to query because they carry `event.name`.

```sql
SELECT
  Timestamp,
  ServiceName,
  LogAttributes['event.name'] AS event_name,
  LogAttributes['enduser.id'] AS enduser_id,
  LogAttributes['session.id'] AS session_id,
  LogAttributes['url.path'] AS url_path
FROM otel_logs
WHERE mapContains(LogAttributes, 'event.name')
ORDER BY Timestamp DESC
LIMIT 100
```

That excludes ordinary logs that do not have `event.name`.

## Important details

- **Import from `@strada.sh/sdk`**. You usually do not need `/node` or `/browser`. Workers resolve automatically via the `workerd` export condition
- **Initialize early**. On Node.js, do it before loading the rest of the app. On Workers, call it at the top of your handler (safe to call every request)
- **Custom events are logs**, not spans
- **Exceptions are logs first**. The collector extracts them into `otel_errors`
- **Browser sessions use `session.id`**, not a single session-wide trace
- **Pageview spans are roots**. Fetch/XHR/user-interaction spans usually become children of the current pageview
- **Session context propagates to the backend** via W3C Baggage. Backend spans and logs within a browser-initiated request automatically get `session.id` and `enduser.id`

## API summary

### Main helpers

- `initStrada(options)`
- `captureException(error, opts?)`
- `setTags(tags)`
- `flush()`
- `shutdown()`

### Re-exported OTel APIs

- `trace`
- `logs`
- `metrics`
- `context`
- `propagation`
- `SpanStatusCode`
- `SpanKind`

## When to use raw OTel vs Strada helpers

- use **raw OTel APIs** for normal spans, logs, and metrics
- use **`captureException()`** when you want Strada error conventions
- use **`track()`** in the browser when you want analytics events in `otel_logs`

## Summary

`@strada.sh/sdk` is a thin OTel setup layer.

It does **not** replace OpenTelemetry. It configures it correctly for Strada, adds a few useful conventions, then gets out of the way.
