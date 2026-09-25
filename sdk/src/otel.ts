/**
 * `@strada.sh/sdk/otel`: the SDK providers in the shapes the global
 * `@opentelemetry/api` expects. Zero dependencies: this file never imports
 * OTel. `@strada.sh/instrumentation` imports it and registers these objects
 * into the real OTel globals with `registerOpenTelemetry()`.
 */

import { getContextManager, loggerProvider, meterProvider, tracerProvider, w3cPropagator, type Context } from "./api.ts";

/**
 * Forwards to the SDK's current context manager, so runtime entries that
 * swap it in initStrada() (AsyncLocalStorage, browser pageview context)
 * stay in effect even if the bridge is registered first.
 */
const contextManager = {
  active: () => getContextManager().active(),
  with: (ctx: Context, fn: (...args: unknown[]) => unknown, thisArg?: unknown, ...args: unknown[]) =>
    getContextManager().with(ctx, fn, thisArg, ...args),
  bind: <T>(ctx: Context, target: T): T => getContextManager().bind(ctx, target),
  enable() {
    return this;
  },
  disable() {
    return this;
  },
};

export const otelProviders = {
  tracerProvider,
  meterProvider,
  loggerProvider,
  propagator: w3cPropagator,
  contextManager,
};
