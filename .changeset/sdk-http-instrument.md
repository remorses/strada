---
'@strada.sh/sdk': minor
---

Add opt-in automatic spans through `node:diagnostics_channel`. No module patching, no preload, no extra packages. Import integrations from `@strada.sh/sdk/instrument`:

```ts
import { initStrada } from '@strada.sh/sdk'
import { fetchSpans, httpClientSpans, httpServerSpans, mysql2Spans, redisSpans } from '@strada.sh/sdk/instrument'

initStrada({
  projectId: '01JTHG5M7XPQR8KNCZ0W4D',
  service: 'api',
  integrations: [fetchSpans(), httpClientSpans(), httpServerSpans(), mysql2Spans(), redisSpans()],
})
```

- `fetchSpans()` and `httpClientSpans()`: client spans for outgoing requests, with `traceparent` and `baggage` headers added. `httpClientSpans()` needs Node 22.12+
- `httpServerSpans()`: a server span for each incoming request, active for the whole handler, parented to the incoming `traceparent`
- `mysql2Spans()` (mysql2 3.20+), `redisSpans()` (redis 5.12+ and ioredis 5.11+), `mongooseSpans()` (mongoose 9.7+): database client spans with `db.*` attributes.
- `graphqlSpans()` (graphql 17+), `aiSpans()` (ai 7+, GenAI spans with token usage), `h3Spans()` (h3 v2 with `tracingPlugin()`)
- `pinoLogs()` (pino 9.10+): every pino log line becomes an OTel log record, correlated to the active span
- Spans from these integrations are active inside the traced call, so nested spans, logs, and errors attach to them

Nothing is enabled by default. Works with any import order and in bundled apps (Vite, Next).

Write your own integration for any library that publishes a `TracingChannel`: an integration is `{ name, setup() }`, where `setup()` returns the teardown that `shutdown()` runs. See https://strada.sh/docs/instrumentation.

`registerOpenTelemetry()` from `@strada.sh/sdk/otel` is now all or nothing: if another OTel SDK already owns one global, it rolls back every global it set and returns an error.
