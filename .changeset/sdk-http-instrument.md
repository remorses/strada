---
'@strada.sh/sdk': minor
---

Add opt-in HTTP spans on Node through `node:diagnostics_channel`. No module patching, no preload, no extra packages:

```ts
initStrada({
  projectId: '01JTHG5M7XPQR8KNCZ0W4D',
  service: 'api',
  instrument: ['fetch', 'http-client', 'http-server'],
})
```

- `fetch` and `http-client`: client spans for outgoing requests, with `traceparent` and `baggage` headers added
- `http-server`: a server span for each incoming request, active for the whole handler, parented to the incoming `traceparent`

Nothing is enabled by default. Works with any import order and in bundled apps (Vite, Next). Requires Node 22.12+.

`registerOpenTelemetry()` from `@strada.sh/sdk/otel` is now all or nothing: if another OTel SDK already owns one global, it rolls back every global it set and returns an error.
