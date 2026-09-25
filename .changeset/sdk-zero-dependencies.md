---
'@strada.sh/sdk': minor
---

The SDK now has **zero dependencies**. It implements the OpenTelemetry API itself and exports OTLP JSON with `fetch`. The install drops about 25 MB of OpenTelemetry and protobuf packages, and each runtime bundle is about 30 kB minified.

The API stays OpenTelemetry-shaped. `trace`, `context`, `propagation`, `logs`, `metrics`, `SpanStatusCode`, `SpanKind`, and `SeverityNumber` from `@strada.sh/sdk` work like `@opentelemetry/api`. Metrics now also work on Cloudflare Workers.

To connect OTel instrumentations or libraries that import `@opentelemetry/api` (Vercel AI SDK, Prisma), register Strada as the global provider:

```ts
import { initStrada } from '@strada.sh/sdk'
import { registerOpenTelemetry } from '@strada.sh/sdk/otel'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'

initStrada({ projectId: '01JTHG5M7XPQR8KNCZ0W4D', service: 'api' })
registerOpenTelemetry()
registerInstrumentations({ instrumentations: [getNodeAutoInstrumentations()] })
```

Other changes:

- The Node entry no longer installs `SIGINT` / `SIGTERM` handlers, so Ctrl+C exits normally. Call `await flush()` in your own shutdown handler. `beforeExit` still flushes.
- New `captureUncaughtErrors: false` option skips the uncaught error handlers, for CLIs that own their crash handling.
- No more `host.*` / `process.*` resource detection: hostname and OS username are never sent.
- Keep-alive connections are reused between flushes.
- Removed: `diag`, the `debug` option, and OTel SDK config types (`BatchSpanProcessorBrowserConfig`, ...). `telemetry.*` now takes `scheduledDelayMillis`, `maxExportBatchSize`, `maxQueueSize`, `exportTimeoutMillis`, and `exportIntervalMillis`.
- `@strada.sh/light` is deprecated. Use `@strada.sh/sdk`.
