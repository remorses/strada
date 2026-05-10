# Changelog

## 0.3.0

1. **`startSpan` convenience helper** -- Sentry-style ergonomic span creation without tracer ceremony. Auto-ends the span, auto-records exceptions with ERROR status, and auto-parents child spans via context propagation:

   ```ts
   const result = await startSpan({ name: 'checkout' }, async (span) => {
     span.setAttribute('order.id', 'ord_123')
     return await processOrder()
   })
   ```

   Handles both sync and async callbacks. Errors are recorded on the span and re-thrown. All standard OTel `SpanOptions` (links, startTime, root, kind, attributes) are passed through.

2. **`startInactiveSpan` for background work** -- creates a span without setting it active in context, so it does not parent subsequent child spans. Returns a `DisposableSpan` that supports the `using` keyword for automatic cleanup:

   ```ts
   {
     using span = startInactiveSpan({ name: 'bg-task' })
     span.setAttribute('queue', 'jobs')
   } // span.end() called automatically via Symbol.dispose
   ```

   Also works with manual `span.end()` calls. Calling `end()` twice is silently ignored.

3. **Dev mode auto-detection for faster flush** -- when `import.meta.hot` is truthy (Vite, Webpack HMR, RSC dev servers), batch processors use 500ms flush intervals for traces and logs (down from 5s default) and 2s for metrics (down from 10s). Logs, errors, and spans appear almost instantly during development. No config change needed; production behavior is unchanged.

## 0.2.0

1. **Vite release metadata plugin** -- new `@strada.sh/sdk/vite` export injects commit, branch, and deployment info into browser builds automatically. No manual `initStrada({ release })` needed:

   ```ts
   // vite.config.ts
   import { stradaVitePlugin } from '@strada.sh/sdk/vite'

   export default {
     plugins: [stradaVitePlugin()],
   }
   ```

   Reads platform-provided variables (Vercel, Cloudflare Pages, GitHub Actions, Netlify) at build time, falls back to local git. Injects `service.version`, `vcs.ref.head.revision`, `vcs.ref.head.name`, and `deployment.id` as OTel resource attributes.

2. **Server-side ingest token support** -- `initStrada({ token })` sends an `Authorization: Bearer` header on every OTLP export request. Server SDKs (Node, Cloudflare Workers) use this for authenticated ingest. Browser builds intentionally ignore `token` to avoid leaking secrets:

   ```ts
   // Node / Workers
   initStrada({
     projectId: '...',
     token: process.env.STRADA_TOKEN,
   })
   ```

3. **`enabled` flag to disable telemetry export** -- initialize with `enabled: false` to keep OTel providers active without attaching OTLP exporters. Useful for dev servers where HMR traffic shouldn't pollute ingest:

   ```ts
   initStrada({
     projectId: '...',
     enabled: !import.meta.hot,
   })
   ```

4. **Unhandled errors now annotate the active span** -- `captureException()` still emits a log record (the primary path), but unhandled errors also set `ERROR` status and record an `exception` event on the active span. This keeps trace views honest when an operation fails. Browser falls back to the pageview span when no child span is active.

5. **GitHub Actions release metadata improvements** -- PR workflows now prefer `GITHUB_HEAD_REF` over `GITHUB_REF_NAME` for the branch name, and `GITHUB_RUN_ID` is used as `deployment.id` when available.

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
