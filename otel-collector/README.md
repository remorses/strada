# otel-collector

OTLP HTTP/JSON collector for [Strada](https://strada.sh). Runs as a Cloudflare Worker. Receives OpenTelemetry traces, logs, and metrics from any OTel SDK and stores them in Tinybird or ClickHouse.

**JSON only.** No protobuf, no gRPC. The OTel JS SDK defaults to `http/protobuf`, so you must use the `-http` exporter packages or set `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`.

## Quick start examples

### Node.js server

#### 1. Install

```bash
npm install @opentelemetry/sdk-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-metrics-otlp-http \
  @opentelemetry/exporter-logs-otlp-http \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/sdk-metrics \
  @opentelemetry/sdk-logs
```

#### 2. Create `instrumentation.ts`

Copy this file into your project. It must be loaded **before** your app code.

```typescript
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { Resource } from "@opentelemetry/resources";
import { SeverityNumber, logs } from "@opentelemetry/api-logs";

// ── Configuration ──────────────────────────────────────────────────────────
// Replace with your Strada ingest URL and server-side token.
// Get both from `strada projects create <slug>` or create another token with
// `strada tokens create production-server`.
// Each project gets a subdomain: {project}-ingest.strada.sh
// Self-hosted: use your own domain, e.g. https://ingest.mycompany.com
const STRADA_URL = "https://acme-ingest.strada.sh";
const STRADA_TOKEN = process.env.STRADA_TOKEN!;
const headers = { Authorization: `Bearer ${STRADA_TOKEN}` };

const resource = new Resource({
  "service.name": "my-api", // groups data under this service in the UI
  "service.version": "1.0.0", // maps to Release in error tracking
  "deployment.environment.name": "production", // maps to Environment
});

// ── Log exporter (used for both logs and error capture) ────────────────────
const logExporter = new OTLPLogExporter({
  url: `${STRADA_URL}/v1/logs`,
  headers,
});

const loggerProvider = new LoggerProvider({ resource });
loggerProvider.addLogRecordProcessor(
  new BatchLogRecordProcessor(logExporter),
);
logs.setGlobalLoggerProvider(loggerProvider);

const logger = loggerProvider.getLogger("strada");

// ── SDK setup (traces + metrics + auto-instrumentation) ────────────────────
const sdk = new NodeSDK({
  resource,
  traceExporter: new OTLPTraceExporter({
    url: `${STRADA_URL}/v1/traces`,
    headers,
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${STRADA_URL}/v1/metrics`,
      headers,
    }),
    exportIntervalMillis: 10_000,
  }),
  // Auto-instrumentation patches http, express, pg, mysql, redis, etc.
  // and creates trace spans automatically. No code changes needed.
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

// ── Error capture ──────────────────────────────────────────────────────────
// Send an exception to Strada as an OTel log record.
// The ingest worker extracts exception.type + exception.message from log
// attributes and writes a denormalized row to the otel_errors table for
// issue grouping and error tracking.
export function captureException(
  error: Error,
  opts?: {
    /** Was this error caught by user code (true) or a global handler (false)? */
    handled?: boolean;
    /** Extra tags attached to the error (e.g. { userId: "123" }) */
    tags?: Record<string, string>;
  },
) {
  const fingerprint = Array.isArray(error["fingerprint"])
    ? error["fingerprint"]
    : undefined;

  const attributes: Record<string, string> = {
    "exception.type": error.name,
    "exception.message": error.message,
    "exception.stacktrace": error.stack ?? "",
    "exception.mechanism.type": opts?.handled === false ? "onerror" : "generic",
    "exception.mechanism.handled": String(opts?.handled ?? true),
  };

  if (fingerprint) {
    attributes["exception.fingerprint"] = JSON.stringify(fingerprint);
  }

  if (opts?.tags) {
    for (const [k, v] of Object.entries(opts.tags)) {
      attributes[k] = v;
    }
  }

  logger.emit({
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    body: error.message,
    attributes,
  });
}

// ── Global handlers (catch unhandled errors) ───────────────────────────────
process.on("uncaughtException", (error) => {
  captureException(error, { handled: false });
  loggerProvider.forceFlush().then(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  const error =
    reason instanceof Error ? reason : new Error(String(reason));
  captureException(error, { handled: false });
});

// ── Graceful shutdown ──────────────────────────────────────────────────────
async function shutdown() {
  await sdk.shutdown();
  await loggerProvider.shutdown();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

#### 3. Load instrumentation before your app

```bash
node --import ./instrumentation.ts app.ts
```

Or with `tsx`:

```bash
tsx --import ./instrumentation.ts app.ts
```

#### 4. Capture errors in your code

```typescript
import { captureException } from "./instrumentation.ts";

class CheckoutError extends Error {
  fingerprint = ["checkout-failed", "processOrder"];

  constructor(message: string) {
    super(message);
    this.name = "CheckoutError";
  }
}

app.post("/orders", async (req, res) => {
  try {
    await processOrder(req.body);
    res.json({ ok: true });
  } catch (err) {
    const error =
      err instanceof CheckoutError
        ? err
        : new CheckoutError("payment provider rejected the charge");

    captureException(error, {
      handled: true,
      tags: { orderId: req.body.id, userId: req.user.id },
    });
    res.status(500).json({ error: "Internal error" });
  }
});
```

### Web browser

#### 1. Install

```bash
npm install @opentelemetry/sdk-trace-web \
  @opentelemetry/sdk-trace-base \
  @opentelemetry/sdk-logs \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-logs-otlp-http \
  @opentelemetry/auto-instrumentations-web
```

#### 2. Create `instrumentation.ts`

Load this once at app startup, before rendering your app.

```typescript
import { SeverityNumber, logs } from "@opentelemetry/api-logs";
import { Resource } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { getWebAutoInstrumentations } from "@opentelemetry/auto-instrumentations-web";
import { registerInstrumentations } from "@opentelemetry/instrumentation";

const STRADA_URL = "https://acme-ingest.strada.sh";

// Browser instrumentation intentionally does not send Authorization headers.
// Browser ingest is anonymous and rate limited because browser secrets are public.

const resource = new Resource({
  "service.name": "my-web-app",
  "service.version": "1.0.0",
  "deployment.environment.name": "production",
});

function shouldIgnoreBrowserError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const stack = error instanceof Error ? error.stack ?? "" : "";

  if (message === "Script error." || message === "Script error") return true;
  if (message.includes("ResizeObserver loop limit exceeded")) return true;
  if (message.includes("ResizeObserver loop completed with undelivered notifications")) return true;

  return (
    stack.includes("chrome-extension://") ||
    stack.includes("moz-extension://") ||
    stack.includes("safari-extension://")
  );
}

class FilteringLogProcessor implements LogRecordProcessor {
  constructor(private readonly inner: LogRecordProcessor) {}

  onEmit(...args: Parameters<LogRecordProcessor["onEmit"]>) {
    const record = args[0];
    const message = String(record.attributes["exception.message"] ?? "");
    const stack = String(record.attributes["exception.stacktrace"] ?? "");

    if (message === "Script error." || message === "Script error") return;
    if (message.includes("ResizeObserver loop limit exceeded")) return;
    if (message.includes("ResizeObserver loop completed with undelivered notifications")) return;
    if (stack.includes("chrome-extension://")) return;
    if (stack.includes("moz-extension://")) return;
    if (stack.includes("safari-extension://")) return;

    this.inner.onEmit(...args);
  }

  forceFlush() {
    return this.inner.forceFlush();
  }

  shutdown() {
    return this.inner.shutdown();
  }
}

const tracerProvider = new WebTracerProvider({ resource });
tracerProvider.addSpanProcessor(
  new BatchSpanProcessor(
    new OTLPTraceExporter({ url: `${STRADA_URL}/v1/traces` }),
  ),
);
tracerProvider.register();

const loggerProvider = new LoggerProvider({ resource });
loggerProvider.addLogRecordProcessor(
  new FilteringLogProcessor(
    new BatchLogRecordProcessor(
      new OTLPLogExporter({ url: `${STRADA_URL}/v1/logs` }),
    ),
  ),
);
logs.setGlobalLoggerProvider(loggerProvider);

const logger = loggerProvider.getLogger("strada-web");

registerInstrumentations({
  instrumentations: [getWebAutoInstrumentations()],
});

export function captureException(
  error: Error,
  opts?: {
    handled?: boolean;
    tags?: Record<string, string>;
  },
) {
  if (shouldIgnoreBrowserError(error)) return;

  const fingerprint = Array.isArray(error["fingerprint"])
    ? error["fingerprint"]
    : undefined;

  const attributes: Record<string, string> = {
    "exception.type": error.name,
    "exception.message": error.message,
    "exception.stacktrace": error.stack ?? "",
    "exception.mechanism.type": opts?.handled === false ? "onerror" : "generic",
    "exception.mechanism.handled": String(opts?.handled ?? true),
  };

  if (fingerprint) {
    attributes["exception.fingerprint"] = JSON.stringify(fingerprint);
  }

  if (opts?.tags) {
    for (const [k, v] of Object.entries(opts.tags)) {
      attributes[k] = v;
    }
  }

  logger.emit({
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    body: error.message,
    attributes,
  });
}

window.addEventListener("error", (event) => {
  if (shouldIgnoreBrowserError(event.error ?? event.message)) return;
  if (event.error instanceof Error) {
    captureException(event.error, { handled: false });
  }
});

window.addEventListener("unhandledrejection", (event) => {
  const error =
    event.reason instanceof Error
      ? event.reason
      : new Error(String(event.reason));

  if (shouldIgnoreBrowserError(error)) return;
  captureException(error, { handled: false });
});
```

#### 3. Load instrumentation before your app

```typescript
import "./instrumentation.ts";
import "./main.tsx";
```

#### 4. Capture handled errors in your code

```typescript
import { captureException } from "./instrumentation.ts";

class CheckoutError extends Error {
  fingerprint = ["checkout-failed", "submit-order"];

  constructor(message: string) {
    super(message);
    this.name = "CheckoutError";
  }
}

async function submitOrder(payload: unknown) {
  try {
    await fetch("/api/orders", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    captureException(
      error instanceof CheckoutError
        ? error
        : new CheckoutError("checkout request failed"),
      {
        handled: true,
        tags: { route: "/checkout" },
      },
    );
    throw error;
  }
}
```

## What the SDK does under the hood

Once `sdk.start()` runs, the OTel SDK works in the background. You don't call it directly for traces or metrics.

**Traces** (automatic). Auto-instrumentation monkey-patches `http`, `express`, `pg`, `mysql`, `redis`, `fetch`, etc. Every incoming HTTP request, every DB query, every outgoing fetch creates a **span** automatically. Spans are batched by `BatchSpanProcessor` and flushed via `POST /v1/traces` every **5 seconds** (or when the batch hits **512 spans**). You get a full distributed trace without writing any tracing code.

**Metrics** (automatic). `PeriodicExportingMetricReader` collects runtime metrics (event loop lag, GC pauses, active handles) and any custom counters/histograms you create. Flushed via `POST /v1/metrics` every **10 seconds** (configured above; OTel default is 60s).

**Logs** (manual). The SDK does not capture `console.log` automatically. Use `logger.emit()` directly or call `captureException()` to send error logs. Batched by `BatchLogRecordProcessor` and flushed via `POST /v1/logs` every **1 second** (or at **512 records**).

**Errors** (manual). `captureException()` is just a convenience wrapper around `logger.emit()` that sets the right `exception.*` attributes. The Strada ingest worker detects these attributes and extracts a row into `otel_errors` for issue grouping and error tracking. The original log is also written to `otel_logs`. Set `error.fingerprint` when you want to override the default grouping logic for a known class of errors.

| Signal  | How it's sent        | Batch interval | Batch size | Endpoint       |
| ------- | -------------------- | -------------- | ---------- | -------------- |
| Traces  | Automatic            | 5s             | 512 spans  | `/v1/traces`   |
| Metrics | Automatic            | 10s            | N/A        | `/v1/metrics`  |
| Logs    | `logger.emit()`      | 1s             | 512 logs   | `/v1/logs`     |
| Errors  | `captureException()` | 1s             | 512 logs   | `/v1/logs`     |

All exports use **HTTP POST with JSON body**. No auth headers needed; project identity comes from the hostname.

## Environment variable configuration

Instead of hardcoding URLs, you can use standard OTel env vars:

```bash
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=https://acme-ingest.strada.sh
export OTEL_SERVICE_NAME=my-api
```

The SDK auto-appends `/v1/traces`, `/v1/logs`, `/v1/metrics` to the base endpoint. No API keys needed.

## Exporter packages

The OTel JS SDK has separate npm packages per wire format. Always use the `-http` variants:

| Package                                    | Format        | Works with Strada? |
| ------------------------------------------ | ------------- | ------------------ |
| `@opentelemetry/exporter-trace-otlp-http`  | HTTP/JSON     | Yes                |
| `@opentelemetry/exporter-trace-otlp-proto` | HTTP/Protobuf | No                 |
| `@opentelemetry/exporter-trace-otlp-grpc`  | gRPC          | No                 |

Same pattern for metrics (`exporter-metrics-otlp-*`) and logs (`exporter-logs-otlp-*`).

## Endpoints

| Method | Path          | Description                                                    |
| ------ | ------------- | -------------------------------------------------------------- |
| POST   | `/v1/traces`  | Receive trace spans                                            |
| POST   | `/v1/logs`    | Receive log records (+ error extraction)                       |
| POST   | `/v1/metrics` | Receive metrics (gauge, sum, histogram, exponential histogram) |

## Local development

```bash
pnpm dev:localhost          # listens on 127.0.0.1:4318
PORT=8081 pnpm dev:localhost # custom port
```

## Integration tests

Boots a fake ClickHouse backend + the collector + real OTel SDK exporters:

```bash
pnpm test:integration
```

Uses random ports by default. Pin with `OTEL_COLLECTOR_TEST_PORT` / `OTEL_COLLECTOR_FAKE_BACKEND_PORT`.

## Project isolation

Project identity comes from the hostname. No SDK configuration needed, just point at the right subdomain:

```
https://acme-ingest.strada.sh      → project "acme"
https://myapp-ingest.strada.sh     → project "myapp"
https://ingest.yourdomain.com      → empty project (self-hosted)
```

No API keys. The hostname IS the project identity (same model as Sentry's DSN). Security is enforced on reads via Tinybird JWT, not on writes.

## Links

- [OTel JS SDK docs](https://opentelemetry.io/docs/languages/js/)
- [OTel JS Exporters](https://opentelemetry.io/docs/languages/js/exporters/)
- [OTLP Exporter Configuration](https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/)
- [`@opentelemetry/exporter-trace-otlp-http`](https://www.npmjs.com/package/@opentelemetry/exporter-trace-otlp-http)
- [`@opentelemetry/exporter-metrics-otlp-http`](https://www.npmjs.com/package/@opentelemetry/exporter-metrics-otlp-http)
- [`@opentelemetry/exporter-logs-otlp-http`](https://www.npmjs.com/package/@opentelemetry/exporter-logs-otlp-http)
