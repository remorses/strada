# Changelog

## 0.1.0

1. **Initial release** -- OTel-first SDK for error tracking, tracing, logs, metrics, and browser analytics. One `initStrada()` call configures all OTel providers; standard APIs (`trace.getTracer()`, `logs.getLogger()`, `metrics.getMeter()`) work immediately after.

2. **Three runtime entries** -- import from `@strada.sh/sdk` everywhere. Export conditions resolve to the right runtime automatically:

   | Import | Runtime |
   | ------ | ------- |
   | `@strada.sh/sdk` | Node (default), Browser (`"browser"` condition), Workers (`"workerd"` condition) |
   | `@strada.sh/sdk/node` | Explicit Node entry |
   | `@strada.sh/sdk/browser` | Explicit browser entry |

3. **Cloudflare Workers runtime** -- uses `BasicTracerProvider` from sdk-trace-base (no Node or browser deps), `AsyncLocalStorage` for context propagation (requires `nodejs_compat`), and auto-flushes via `waitUntil` from `cloudflare:workers`. Zero HTTP requests unless user code explicitly calls SDK methods.

4. **`captureException(error, opts?)`** -- normalizes errors, applies filtering (`ignoreErrors`, `denyUrls`, `beforeSend`), builds `exception.*` attributes, and emits an OTel log record. Works across all three runtimes.

5. **`track(name, props?)`** -- custom product events as OTel log records with `event.name` and `custom.*` prefixed attributes. Browser builds auto-correlate events to the active pageview span.

6. **Browser session management** -- per-tab UUID in `sessionStorage` (`strada.session_id`), injected as `session.id` into every span and log. Survives page refreshes, resets on tab close.

7. **Browser pageview spans** -- `startPageSpan()` / `endCurrentPageSpan()` create `pageview` spans. First pageview starts on `initStrada()`, ends on `visibilitychange: hidden`. SPA router plugins call these on navigation.

8. **Browser-to-server context propagation** -- `session.id` and `user.id` travel from browser to backend via W3C Baggage headers. `BaggageSpanProcessor` and `BaggageLogProcessor` on the Node side extract them automatically. Backend spans carry the same session and user identity as browser telemetry.

9. **Vercel auto-flush** -- when `VERCEL=1` is set, the SDK switches from timer-based batch flushing to per-span/log `waitUntil` flushing so data isn't lost on scale-to-zero.

10. **Structured SDK logger** -- `createStradaLogger()` returns a typed logger with `debug`, `info`, `warn`, `error` methods. Node uses `node:util.inspect` formatting; browser and Workers use JSON.

11. **Node custom event tracking** -- `track()` works in the Node runtime too, emitting log records with `event.name` and `custom.*` attributes.

12. **Re-exported OTel APIs** -- `trace`, `context`, `metrics`, `propagation`, `diag`, `logs`, `SpanStatusCode`, `SpanKind`, `SeverityNumber` plus key types. Users don't need to install `@opentelemetry/api` separately.
