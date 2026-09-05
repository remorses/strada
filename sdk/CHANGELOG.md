# Changelog

## 0.6.0

1. **`trackPageview()` for server-side pageviews** — emit a zero-duration `pageview` span from Node or Cloudflare Workers. It lands in the same analytics materialized views as browser pageviews, so bots, AI crawlers, JS-blocked visitors, and SSR-only pages show up in analytics:

   ```ts
   import { initStrada, trackPageview } from "@strada.sh/sdk"

   app.use((req, res, next) => {
     trackPageview({
       path: req.path,
       url: req.url,
       referrer: req.headers.referer,
     })
     next()
   })
   ```

   Cloudflare Workers:

   ```ts
   export default {
     fetch(request, env) {
       initStrada({ projectId: "...", service: "docs", token: env.STRADA_TOKEN })
       const url = new URL(request.url)
       trackPageview({ path: url.pathname, url: url.href })
     },
   }
   ```

   `session.id` and `user.id` come from W3C Baggage when not passed. Relative URLs are parsed safely; only absolute URLs set `url.full`.

2. **Cloudflare native tracing bridge** — when `tracing.enterSpan` is available (workerd 2026-06-16+), every `startActiveSpan()` also creates a Cloudflare native span. Custom OTel spans then appear in the Cloudflare trace waterfall next to auto-instrumented KV, D1, and fetch spans.

   Auto-enabled at runtime. Disable with `cloudflareTracing: false`:

   ```ts
   initStrada({
     projectId: "...",
     token: env.STRADA_TOKEN,
     cloudflareTracing: false,
   })
   ```

3. **Better Auth plugin reports API errors** — `strataBetterAuth()` now calls `captureException` on Better Auth `onAPIError` failures, tagged `source: better-auth`.

## 0.5.0

1. **Automatic request context propagation into errors and logs** -- `captureException()` and manual log records inside HTTP handlers now automatically carry `url.path`, `http.route`, `http.method`, and other request-scoped attributes without any app code. `BaggageLogProcessor` reads curated attributes from the active span and injects them into every log record:

   ```ts
   app.get('/api/orders', async (req, res) => {
     // The HTTP handler span has url.path="/api/orders"
     // Any error captured here automatically includes it
     captureException(new Error('out of stock'))
     // → error row in otel_errors has Tags["url.path"] = "/api/orders"
   })
   ```

   This works for all server runtimes (Node, Cloudflare Workers). Nested child spans (DB queries, HTTP client calls) inherit parent request context unless they have their own URL attributes.

2. **Child span attributes no longer overwritten by parent** -- `BaggageSpanProcessor` was unconditionally copying parent attributes to child spans, overwriting the child's own values. For example, a client span `POST /v1/payment_intents` inside a server handler `GET /checkout` would incorrectly show the parent's `url.path`. Fixed by checking `hasOwnProperty` on the child span before setting parent values.

3. **Old HTTP semconv normalization** -- spans using old OpenTelemetry semantic conventions (`http.target`, `http.url`) now get `url.path` derived automatically. `http.target` gets its query string stripped; `http.url` gets parsed and the pathname extracted. Both `BaggageSpanProcessor` and `BaggageLogProcessor` apply this normalization as a fallback.

4. **Telemetry export disabled by default in dev mode** -- when `import.meta.hot` is truthy (Vite, Webpack HMR, RSC dev servers), telemetry is no longer sent to the ingest endpoint. Local OTel providers still work so `trace.getTracer()` and `logs.getLogger()` function during development; only the network export is suppressed. Override with `enabled: true` to force export in dev, or `enabled: false` to disable everywhere:

   ```ts
   initStrada({
     projectId: '...',
     enabled: true, // force export even in dev
   })
   ```

## 0.4.0

1. **Better Auth integration plugin** -- new `@strada.sh/sdk/better-auth` export provides a type-only Better Auth plugin that tracks auth lifecycle events (signup, login, logout) and sets the `strada_uid` cookie for browser SDK user correlation:

   ```ts
   import { strataBetterAuth } from '@strada.sh/sdk/better-auth'

   const auth = betterAuth({
     plugins: [
       strataBetterAuth({
         includeUserDetails: true, // track email and name in events
       }),
     ],
   })
   ```

   The plugin emits structured OTel log events for each auth action with user details, auth method, and provider. Cookie setting uses the `{ headers }` return mechanism from after hooks, not `ctx.setCookie()`.

2. **`identifyUser()` for server-side user profiles** -- emit user profile telemetry from trusted server runtimes. Profile fields (email, name, image, organization) are sent as a reserved `strada.user.identify` OTLP log event and stored in the `otel_users` table:

   ```ts
   import { identifyUser } from '@strada.sh/sdk'

   identifyUser({
     id: 'user_123',
     email: 'alice@example.com',
     name: 'Alice',
     organizationId: 'org_456',
   })
   ```

   Available in Node, Cloudflare Workers, and browser runtimes. Browser calls only update the local cookie; profile writes require server-side calls.

3. **Fixed cookie setting in Better Auth after hooks** -- the plugin was calling `ctx.setCookie()` which is undefined at runtime in Better Auth's `HookEndpointContext`. Now correctly returns `{ headers }` with serialized Set-Cookie headers.

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
