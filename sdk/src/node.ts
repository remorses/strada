/**
 * Node.js, Bun, and Deno entry for @strada.sh/sdk. Zero dependencies.
 *
 * - Context survives `await` through AsyncLocalStorage.
 * - Resource is only what you configure plus release metadata from env
 *   (STRADA_RELEASE_*, VERCEL_GIT_*, GITHUB_SHA, ...). No hostname, OS
 *   username, or command args.
 * - Uncaught exceptions and unhandled rejections are captured unless
 *   `captureUncaughtErrors: false`. An uncaught exception still exits with
 *   code 1 after a flush, like Node without a handler.
 * - Buffered telemetry is flushed on `beforeExit`. The SDK installs no
 *   SIGINT/SIGTERM handlers, so Ctrl+C keeps its default behavior; call
 *   `flush()` in your own shutdown handler.
 * - `instrument: ["fetch", "http-client", "http-server"]` adds HTTP spans
 *   through diagnostics_channel (instrument-http.ts). Off by default.
 * - On Vercel, every record registers a `waitUntil` flush through the native
 *   request context (`Symbol.for('@vercel/request-context')`), because Vercel
 *   freezes the process between requests and batch timers never fire.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { AsyncContextManager, runtimeHooks, setContextManager, type Context } from "./api.ts";
import { ATTR } from "./attrs.ts";
import { captureException, flush, shutdown as shutdownClient } from "./client.ts";
import { instrumentHttp } from "./instrument-http.ts";
import { serverHooks } from "./server.ts";
import { initCore, normalizeError, resolveReleaseAttributes, tryTelemetry, type StradaOptions } from "./shared.ts";

export * from "./client.ts";
export { identifyUser, trackPageview } from "./server.ts";

const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

type VercelRequestContext = { get?: () => { waitUntil?: (promise: Promise<unknown>) => void } | undefined };

function getVercelWaitUntil(): ((promise: Promise<unknown>) => void) | undefined {
  const holder = (globalThis as Record<symbol, VercelRequestContext | undefined>)[VERCEL_REQUEST_CONTEXT];
  return holder?.get?.()?.waitUntil;
}

let flushScheduled = false;

/** No-op outside a Vercel request: batch timers handle export as usual. */
function scheduleVercelFlush(): void {
  const waitUntil = getVercelWaitUntil();
  if (!waitUntil || flushScheduled) return;
  flushScheduled = true;
  waitUntil(
    Promise.resolve().then(async () => {
      flushScheduled = false;
      // flush() already warned about failures; nobody else can handle them here.
      void (await flush());
    }),
  );
}

let processHandlersInstalled = false;

function installProcessHandlers(options: StradaOptions): void {
  if (processHandlersInstalled || typeof process === "undefined" || typeof process.on !== "function") return;
  processHandlersInstalled = true;

  // beforeExit fires when the event loop drains (not on process.exit() or
  // signals) and can run async work. One shot, so a flush cannot loop.
  const beforeExitHandler = () => {
    process.removeListener("beforeExit", beforeExitHandler);
    void flush();
  };
  process.on("beforeExit", beforeExitHandler);

  if (options.captureUncaughtErrors === false) return;
  // The SDK's own handlers drop the Error that captureException and flush
  // return: there is nobody left to report it to, and it was already warned.
  process.on("uncaughtException", (error) => {
    void captureException(error, { handled: false, mechanism: "uncaughtException" });
    void flush().finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    void captureException(normalizeError(reason), { handled: false, mechanism: "unhandledRejection" });
  });
}

export function initStrada(options: StradaOptions): Error | undefined {
  return tryTelemetry({
    operation: "initStrada()",
    run: () => {
      const started = initCore({
        options,
        resource: {
          [ATTR["service.name"]]: options.service,
          ...resolveReleaseAttributes(options, typeof process === "undefined" ? undefined : process.env),
          [ATTR["deployment.environment.name"]]: options.environment,
        },
      });
      if (!started) return;
      const storage = new AsyncLocalStorage<Context>();
      setContextManager(new AsyncContextManager(storage));
      runtimeHooks.onSpanStart = serverHooks.onSpanStart;
      runtimeHooks.onLogEmit = serverHooks.onLogEmit;
      runtimeHooks.afterRecord = scheduleVercelFlush;
      installProcessHandlers(options);
      uninstrumentHttp = options.instrument?.length ? instrumentHttp({ instrument: options.instrument, storage }) : undefined;
    },
  });
}

let uninstrumentHttp: (() => void) | undefined;

/** Flush, stop exporting, and unsubscribe HTTP instrumentation. */
export async function shutdown(): Promise<Error | undefined> {
  uninstrumentHttp?.();
  uninstrumentHttp = undefined;
  return shutdownClient();
}
