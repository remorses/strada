/**
 * Cloudflare Workers entry for @strada.sh/sdk (the `workerd` export
 * condition). Zero dependencies, requires `nodejs_compat` for
 * AsyncLocalStorage.
 *
 * Explicit only: nothing is sent unless user code calls captureException(),
 * track(), getLogger(), startSpan(), or the OTel-shaped trace/logs/metrics
 * API. For automatic KV, D1, DO, and fetch spans use Cloudflare's built-in
 * tracing (`observability.traces.enabled` in wrangler.jsonc).
 *
 * When `tracing.enterSpan` from `cloudflare:workers` exists (workerd
 * 2026-06-16+), every startActiveSpan() also opens a native Cloudflare span,
 * so custom spans show in the Cloudflare trace waterfall next to KV/D1/fetch
 * spans. Disable with `cloudflareTracing: false`.
 *
 * The first record registers a debounced flush with `waitUntil` from
 * `cloudflare:workers`, so the invocation stays alive until telemetry is
 * delivered. Users never need to call flush() or pass ctx around. The flush
 * waits until records stop for a moment (see `scheduleWaitUntilFlush` in
 * export.ts), so one invocation usually costs one ingest request, and
 * concurrent requests in the same isolate share it. No flush waits for another
 * invocation, because Workers bind I/O and promises to the request that
 * created them.
 *
 * Env type comes from wrangler types (worker-configuration.d.ts), never define
 * custom Env interfaces. See the cloudflare-workers skill for conventions.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as cfWorkers from "cloudflare:workers";
import { AsyncContextManager, runtimeHooks, setContextManager, type Context } from "./api.ts";
import { ATTR } from "./attrs.ts";
import { scheduleWaitUntilFlush } from "./export.ts";
import { serverHooks } from "./server.ts";
import { initCore, resolveReleaseAttributes, setupIntegrations, tryTelemetry, type StradaOptions } from "./shared.ts";

export * from "./client.ts";
export { identifyUser, trackPageview } from "./server.ts";

// Older workerd versions do not export `tracing`, so read it without trusting the type.
const cfTracing: typeof cfWorkers.tracing | undefined = Reflect.get(cfWorkers, "tracing");

function scheduleFlush(): void {
  // Called through the module, like enterSpan below: never detach workerd functions.
  scheduleWaitUntilFlush((promise) => cfWorkers.waitUntil(promise));
}

export function initStrada(options: StradaOptions): Error | undefined {
  return tryTelemetry({
    operation: "initStrada()",
    run: () => {
      const started = initCore({
        options,
        resource: {
          [ATTR["service.name"]]: options.service,
          ...resolveReleaseAttributes(options),
          [ATTR["deployment.environment.name"]]: options.environment,
          "cloud.provider": "cloudflare",
          "cloud.platform": "cloudflare.workers",
          [ATTR["faas.name"]]: options.service,
          [ATTR["cloudflare.script_name"]]: options.service,
        },
        invocationScoped: true,
      });
      if (!started) return;
      setContextManager(new AsyncContextManager(new AsyncLocalStorage<Context>()));
      runtimeHooks.onSpanStart = serverHooks.onSpanStart;
      runtimeHooks.onLogEmit = serverHooks.onLogEmit;
      runtimeHooks.afterRecord = scheduleFlush;
      if (options.cloudflareTracing !== false && typeof cfTracing?.enterSpan === "function") {
        // Call as a method: workerd throws "Illegal invocation" on a detached enterSpan.
        const tracing = cfTracing;
        runtimeHooks.wrapActiveSpan = (name, run) => tracing.enterSpan(name, (cfSpan) => run(cfSpan));
      }
      setupIntegrations(options.integrations);
    },
  });
}
