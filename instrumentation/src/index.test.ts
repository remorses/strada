import { context, metrics, propagation, ProxyTracerProvider, trace, type TracerProvider } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { otelProviders } from "@strada.sh/sdk/otel";
import { expect, test } from "vitest";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import { getInstrumentations, registerOpenTelemetry } from "./index.ts";

test("registerOpenTelemetry is all or nothing when another OTel SDK owns a global", () => {
  const otherSdk: TracerProvider = new ProxyTracerProvider();
  trace.setGlobalTracerProvider(otherSdk);

  const error = registerOpenTelemetry();
  expect({
    error: error?.message,
    // The logger was set before the tracer failed and must be rolled back.
    loggerIsStrada: logs.getLoggerProvider() === otelProviders.loggerProvider,
    tracerStillOther: (trace.getTracerProvider() as ProxyTracerProvider).getDelegate() === otherSdk,
    meterIsStrada: metrics.getMeterProvider() === otelProviders.meterProvider,
    contextIsStrada: context.active() === otelProviders.contextManager.active(),
    propagatorFields: propagation.fields(),
  }).toMatchInlineSnapshot(`
    {
      "contextIsStrada": false,
      "error": "@strada.sh/instrumentation: another OpenTelemetry SDK already registered the global tracer provider. Use only one OTel SDK.",
      "loggerIsStrada": false,
      "meterIsStrada": false,
      "propagatorFields": [],
      "tracerStillOther": true,
    }
  `);
});

test("getInstrumentations honors OTEL_NODE_ENABLED/DISABLED_INSTRUMENTATIONS names", () => {
  const names = (list: Instrumentation[]) =>
    list.map((instrumentation) => instrumentation.instrumentationName.replace("@opentelemetry/instrumentation-", ""));
  expect({
    all: names(getInstrumentations({ enabled: [], disabled: [] })).length,
    enabled: names(getInstrumentations({ enabled: ["http", "pg"], disabled: [] })),
    disabled: names(getInstrumentations({ enabled: [], disabled: ["http", "runtime-node"] })).includes("http"),
  }).toMatchInlineSnapshot(`
    {
      "all": 28,
      "disabled": false,
      "enabled": [
        "http",
        "pg",
      ],
    }
  `);
});
