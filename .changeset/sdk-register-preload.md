---
'@strada.sh/sdk': minor
'@strada.sh/instrumentation': minor
---

Add `@strada.sh/instrumentation`: OpenTelemetry auto-instrumentation for the SDK in one install.

```bash
npm install @strada.sh/instrumentation
node --import @strada.sh/instrumentation/register server.js
```

- **Curated default set**, close to Sentry's Node defaults: `http`, `undici`, express, koa, hapi, connect, router, nestjs, graphql, pg, mysql, mysql2, mongodb, mongoose, redis, ioredis, knex, tedious, kafkajs, amqplib, dataloader, generic-pool, lru-memoizer, runtime-node, openai. Loggers (pino, winston, bunyan) only get trace ids, logs are not forwarded. No `fs`, `dns`, or `net` spans.
- Narrow it with `OTEL_NODE_ENABLED_INSTRUMENTATIONS` / `OTEL_NODE_DISABLED_INSTRUMENTATIONS`, or `getInstrumentations({ enabled, disabled })`.
- `registerOpenTelemetry()` from `@strada.sh/instrumentation/otel` connects libraries that call the OTel API (Vercel AI SDK, Prisma). It is all or nothing: if another OTel SDK owns a global, it rolls back and returns an error.

A preload is required: Node loads the whole import graph before app code runs, so instrumentations registered from app code never patch `http`, `pg`, or `express`.

In the SDK, `@strada.sh/sdk/register` forwards to `@strada.sh/instrumentation/register` and prints one warning when that package is not installed. `@strada.sh/sdk/otel` no longer imports `@opentelemetry/*`; it exports `otelProviders`, and `registerOpenTelemetry()` moved to `@strada.sh/instrumentation/otel`. The SDK has no OpenTelemetry peer dependencies anymore.
