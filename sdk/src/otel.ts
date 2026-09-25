/**
 * `@strada.sh/sdk/otel`: register the Strada providers into the global
 * `@opentelemetry/api` and `@opentelemetry/api-logs` singletons.
 *
 * Only needed for libraries that emit telemetry through the OTel API
 * themselves (Vercel AI SDK, Prisma tracing, OTel instrumentations). Their
 * tracers and loggers are proxies that resolve the provider on first use, so
 * this can run anywhere at startup. `@opentelemetry/api` and
 * `@opentelemetry/api-logs` are optional peer dependencies used only here.
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
 * manager, and propagator. All or nothing: if another OTel SDK
 * (`@vercel/otel`, `@opentelemetry/sdk-node`, Sentry) already owns one
 * global, every global this call set is rolled back and an Error is
 * returned, so the process never mixes two providers.
 */
export function registerOpenTelemetry(): Error | undefined {
  const rollbacks: Array<() => void> = [];
  const rollback = (name: string) => {
    for (const undo of rollbacks) undo();
    return new Error(`another OpenTelemetry SDK already registered the global ${name}. Use only one OTel SDK.`);
  };

  // setGlobalLoggerProvider returns the active provider instead of a boolean.
  otelLogs.setGlobalLoggerProvider(loggerProvider as OtelLoggerProvider);
  if (otelLogs.getLoggerProvider() !== loggerProvider) return rollback("logger provider");
  rollbacks.push(() => otelLogs.disable());

  const steps: Array<[string, () => boolean, () => void]> = [
    ["tracer provider", () => otelTrace.setGlobalTracerProvider(tracerProvider as OtelTracerProvider), () => otelTrace.disable()],
    ["context manager", () => otelContext.setGlobalContextManager(contextManagerBridge as OtelContextManager), () => otelContext.disable()],
    ["propagator", () => otelPropagation.setGlobalPropagator(w3cPropagator as OtelTextMapPropagator), () => otelPropagation.disable()],
    ["meter provider", () => otelMetrics.setGlobalMeterProvider(meterProvider as OtelMeterProvider), () => otelMetrics.disable()],
  ];
  for (const [name, set, undo] of steps) {
    if (!set()) return rollback(name);
    rollbacks.push(undo);
  }
  return undefined;
}
