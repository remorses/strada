/**
 * `registerOpenTelemetry()` without the Node instrumentations, so browsers
 * and Workers can import it: `@strada.sh/instrumentation/otel`.
 */

import {
  context,
  metrics,
  propagation,
  trace,
  type ContextManager,
  type MeterProvider,
  type TextMapPropagator,
  type TracerProvider,
} from "@opentelemetry/api";
import { logs, type LoggerProvider } from "@opentelemetry/api-logs";
import { otelProviders } from "@strada.sh/sdk/otel";

/**
 * Register Strada as the global OpenTelemetry provider. All or nothing: if
 * another OTel SDK (`@vercel/otel`, `@opentelemetry/sdk-node`, Sentry)
 * already owns one global, every global this call set is rolled back and an
 * Error is returned, so the process never mixes two providers.
 */
export function registerOpenTelemetry(): Error | undefined {
  const rollbacks: Array<() => void> = [];
  const rollback = (name: string) => {
    for (const undo of rollbacks) undo();
    return new Error(
      `@strada.sh/instrumentation: another OpenTelemetry SDK already registered the global ${name}. Use only one OTel SDK.`,
    );
  };

  logs.setGlobalLoggerProvider(otelProviders.loggerProvider as LoggerProvider);
  if (logs.getLoggerProvider() !== otelProviders.loggerProvider) return rollback("logger provider");
  rollbacks.push(() => logs.disable());

  const steps: Array<[string, () => boolean, () => void]> = [
    ["tracer provider", () => trace.setGlobalTracerProvider(otelProviders.tracerProvider as TracerProvider), () => trace.disable()],
    ["context manager", () => context.setGlobalContextManager(otelProviders.contextManager as ContextManager), () => context.disable()],
    ["propagator", () => propagation.setGlobalPropagator(otelProviders.propagator as TextMapPropagator), () => propagation.disable()],
    ["meter provider", () => metrics.setGlobalMeterProvider(otelProviders.meterProvider as MeterProvider), () => metrics.disable()],
  ];
  for (const [name, set, undo] of steps) {
    if (!set()) return rollback(name);
    rollbacks.push(undo);
  }
  return undefined;
}
