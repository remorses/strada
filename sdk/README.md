# @strada.sh/sdk

**OpenTelemetry-first error tracking, tracing, logs, metrics, and browser analytics for Strada.**

Import from `@strada.sh/sdk` in every runtime. The package uses export conditions so browsers get the browser runtime and servers get the Node runtime.

```ts
import { initStrada, captureException, trace } from "@strada.sh/sdk"

initStrada({
  service: "frontend",
  endpoint: "https://my-project-ingest.strada.sh",
  environment: "production",
  version: "1.0.0",
  telemetry: {
    traces: {
      scheduledDelayMillis: 2000,
      maxExportBatchSize: 256,
    },
    logs: {
      scheduledDelayMillis: 2000,
    },
    metrics: {
      exportIntervalMillis: 5000,
      exportTimeoutMillis: 3000,
    },
  },
})

const tracer = trace.getTracer("app")

const span = tracer.startSpan("checkout")
span.setAttribute("cart.items", 3)
span.end()

try {
  throw new Error("payment failed")
} catch (error) {
  captureException(error)
}
```

## Why use it

- **One import path** for browser and server code
- **Standard OTel APIs** after setup. Keep using `trace`, `logs`, and `metrics`
- **Browser analytics built in**. Pageviews, fetch/XHR spans, custom events, session context
- **Error tracking built on logs**. Exceptions become OTel log records with `exception.*` attributes
- **No custom protocol**. Everything goes through OTLP HTTP

## Install

```bash
pnpm add @strada.sh/sdk
```

Optional peer dependencies for auto-instrumentation:

```bash
pnpm add @opentelemetry/auto-instrumentations-node
pnpm add @opentelemetry/auto-instrumentations-web
```

## Quick start

## Browser

```ts
import { initStrada, captureException, setUser } from "@strada.sh/sdk"

initStrada({
  service: "frontend",
  endpoint: "https://my-project-ingest.strada.sh",
  environment: "production",
  version: "1.0.0",
})

setUser({ id: "user_123", email: "a@example.com" })

window.addEventListener("click", async () => {
  try {
    await fetch("/api/plans")
  } catch (error) {
    captureException(error)
  }
})
```

## Node.js

Call `initStrada()` as early as possible, ideally before importing the rest of the app.

```ts
import { initStrada, captureException, shutdown } from "@strada.sh/sdk"

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
  service: "worker",
  endpoint: "https://my-project-ingest.strada.sh",
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
  service: "api",
  endpoint: "https://my-project-ingest.strada.sh",
})

const tracer = trace.getTracer("checkout")

const span = tracer.startSpan("checkout.request", {
  attributes: {
    "checkout.id": "chk_123",
    "user.id": "user_123",
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
  service: "api",
  endpoint: "https://my-project-ingest.strada.sh",
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
  service: "frontend",
  endpoint: "https://my-project-ingest.strada.sh",
})

const logger = logs.getLogger("app")

logger.emit({
  severityNumber: SeverityNumber.INFO,
  body: "checkout started",
  attributes: {
    "event.name": "checkout_started",
    "user.id": "user_123",
    "custom.plan": "pro",
  },
})
```

### Error logs with raw OTel

```ts
import { initStrada, logs, SeverityNumber } from "@strada.sh/sdk"

initStrada({
  service: "api",
  endpoint: "https://my-project-ingest.strada.sh",
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
  service: "frontend",
  endpoint: "https://my-project-ingest.strada.sh",
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
  service: "api",
  endpoint: "https://my-project-ingest.strada.sh",
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

## Browser custom events

In the browser runtime, Strada also exposes `track()` for product analytics style events.

```ts
import { initStrada, track } from "@strada.sh/sdk"

initStrada({
  service: "frontend",
  endpoint: "https://my-project-ingest.strada.sh",
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
- `user.id` from `setUser()`

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
    "user.id": "user_123",
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
    "user.id": "user_123"
  }
}
```

The collector later extracts these into the `otel_errors` table for grouping and issue views.

## Under the hood

## Root import uses conditions

`@strada.sh/sdk` resolves differently by runtime:

- **browser bundlers** get the browser implementation
- **Node.js / Bun / Deno** get the server implementation

That means the same import path can configure different OTel SDKs without user changes.

## Exporters, batching, and flush behavior

By default the SDK uses **OTLP HTTP JSON exporters** for every signal:

- **browser traces** → `OTLPTraceExporter` to `/v1/traces`
- **browser logs** → `OTLPLogExporter` to `/v1/logs`
- **Node traces** → `OTLPTraceExporter` to `/v1/traces`
- **Node logs** → `OTLPLogExporter` to `/v1/logs`
- **Node metrics** → `OTLPMetricExporter` to `/v1/metrics`

You can tune batching and cadence with `telemetry` in `initStrada()`:

```ts
initStrada({
  service: "api",
  endpoint: "https://my-project-ingest.strada.sh",
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

- `telemetry.metrics` is currently only meaningful on runtimes where Strada configures a metric exporter, which today is Node.js

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

The SDK automatically propagates `session.id` and `user.id` from the browser to the backend using **W3C Baggage**. Every outgoing `fetch`/`XHR` request from the browser includes both `traceparent` and `baggage` HTTP headers.

```text
Browser                                    Server
session.id = abc                           BaggageSpanProcessor reads baggage:
user.id = user_123                           session.id -> span attribute
          |                                  user.id -> span attribute
          | fetch POST /api/checkout
          | headers:                       BaggageLogProcessor reads baggage:
          |   traceparent: 00-abc123...      session.id -> log attribute
          |   baggage: strada.session.id=abc,strada.user.id=user_123
          v
```

This means backend spans and log records created within a browser-initiated request automatically carry the browser's `session.id` and `user.id`. No app code needed.

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
- The `PageviewContextManager` injects current baggage (session.id + user.id) into the OTel context on every outgoing request
- The Node SDK registers the same composite propagator to extract baggage from incoming requests
- `BaggageSpanProcessor` reads the baggage and sets `session.id` / `user.id` as span attributes
- `BaggageLogProcessor` does the same for log records

Baggage updates live. When you call `setUser()` in the browser, the next outgoing request will carry the updated `user.id`.

## Browser runtime

The browser build sets up:

- `WebTracerProvider`
- `LoggerProvider`
- OTLP HTTP exporters for traces and logs
- W3C Baggage propagation for session.id and user.id
- optional `@opentelemetry/auto-instrumentations-web`
- global `error` and `unhandledrejection` handlers
- pageview span lifecycle
- log filtering for noisy browser junk like `Script error.` and extension frames

## Node runtime

The server build sets up:

- `NodeSDK` for traces and metrics
- a separate `LoggerProvider` for logs
- OTLP HTTP exporters for traces, logs, metrics
- W3C Baggage extraction with `BaggageSpanProcessor` and `BaggageLogProcessor`
- optional `@opentelemetry/auto-instrumentations-node`
- global `uncaughtException` and `unhandledRejection` handlers
- `flush()` and `shutdown()` helpers for graceful process exit

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
  LogAttributes['user.id'] AS user_id,
  LogAttributes['session.id'] AS session_id,
  LogAttributes['url.path'] AS url_path
FROM otel_logs
WHERE mapContains(LogAttributes, 'event.name')
ORDER BY Timestamp DESC
LIMIT 100
```

That excludes ordinary logs that do not have `event.name`.

## Important details

- **Import from `@strada.sh/sdk`**. You usually do not need `/node` or `/browser`
- **Initialize early**. Especially on Node.js, do it before loading the rest of the app
- **Custom events are logs**, not spans
- **Exceptions are logs first**. The collector extracts them into `otel_errors`
- **Browser sessions use `session.id`**, not a single session-wide trace
- **Pageview spans are roots**. Fetch/XHR/user-interaction spans usually become children of the current pageview
- **Session context propagates to the backend** via W3C Baggage. Backend spans and logs within a browser-initiated request automatically get `session.id` and `user.id`

## API summary

### Main helpers

- `initStrada(options)`
- `captureException(error, opts?)`
- `setUser(user)`
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
