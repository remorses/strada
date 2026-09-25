/**
 * `@strada.sh/sdk/otel`: register the Strada providers into the global
 * `@opentelemetry/api` and `@opentelemetry/api-logs` singletons.
 *
 * Libraries that emit telemetry through the OTel API (Vercel AI SDK, Prisma,
 * `@opentelemetry/instrumentation-*`) look up these globals. After
 * `registerOpenTelemetry()` their spans, logs, and metrics flow through the
 * same zero-dependency Strada exporter, share context with `startSpan()`,
 * and propagate W3C traceparent + baggage.
 *
 * `@opentelemetry/api` and `@opentelemetry/api-logs` are optional peer
 * dependencies: only apps that import this entry need them, and apps that
 * use OTel-instrumented libraries already have them installed.
 *
 * Registration fails (returns an Error) when another OTel SDK already owns
 * the globals, e.g. `@vercel/otel` or `@opentelemetry/sdk-node`. Use one.
 */

import {
  context as otelContext,
  metrics as otelMetrics,
  propagation as otelPropagation,
  trace as otelTrace,
  type ContextManager as OtelContextManager,
  type MeterProvider as OtelMeterProvider,
  type TextMapPropagator as OtelTextMapPropagator,
  type TracerProvider as OtelTracerProvider,
} from "@opentelemetry/api";
import { logs as otelLogs, type LoggerProvider as OtelLoggerProvider } from "@opentelemetry/api-logs";
import { getContextManager, loggerProvider, meterProvider, tracerProvider, w3cPropagator, type Context } from "./api.ts";
import { tryTelemetry } from "./shared.ts";

/**
 * Forwards to the SDK's current context manager, so runtime entries that
 * swap it in initStrada() (AsyncLocalStorage, browser pageview context)
 * stay in effect even if this is registered first.
 */
const contextManagerBridge = {
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

/**
 * Register Strada as the global OpenTelemetry tracer, meter, logger, context
 * manager, and propagator. Call once at startup, after `initStrada()` and
 * before creating instrumentations.
 */
export function registerOpenTelemetry(): Error | undefined {
  return tryTelemetry({
    operation: "registerOpenTelemetry()",
    run: () => {
      const registered = [
        otelTrace.setGlobalTracerProvider(tracerProvider as OtelTracerProvider),
        otelContext.setGlobalContextManager(contextManagerBridge as OtelContextManager),
        otelPropagation.setGlobalPropagator(w3cPropagator as OtelTextMapPropagator),
        otelMetrics.setGlobalMeterProvider(meterProvider as OtelMeterProvider),
      ];
      otelLogs.setGlobalLoggerProvider(loggerProvider as OtelLoggerProvider);
      if (registered.includes(false)) {
        throw new Error("another OpenTelemetry SDK already registered the global API. Remove it or skip registerOpenTelemetry()");
      }
    },
  });
}
