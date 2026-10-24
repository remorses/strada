---
'@strada.sh/sdk': minor
'otel-collector': patch
---

<!-- depends-on: otel-collector (needs the POST /v1/batch route). Deploy the collector to preview and prod before publishing the SDK. -->

Send fewer ingest requests. Every flush is now **one request** to `/v1/batch` with spans, logs, and metrics together, instead of one request per signal to `/v1/traces`, `/v1/logs`, and `/v1/metrics`.

On **Cloudflare Workers** and **Vercel**, the `waitUntil` flush now waits until no record arrived for 100ms (at most 1s). Before, every span that ended after an `await` sent its own request, so a request with 6 spans cost 6 ingest requests. Now it costs one, and concurrent requests in the same isolate share it too. Workers bill CPU time, not wall time, so the wait is free.

```
before: span ─► POST /v1/traces   span ─► POST /v1/traces   log ─► POST /v1/logs
after:  span, span, log ──(100ms idle)──► POST /v1/batch
```

No code changes needed. The collector keeps accepting the standard OTLP routes for other OTel SDKs.
