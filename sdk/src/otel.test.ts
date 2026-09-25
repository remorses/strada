import { createServer } from "node:http";
import { createRequire } from "node:module";
import { context as otelContext, metrics as otelMetrics, propagation as otelPropagation, ProxyTracerProvider, trace as otelTrace, type TracerProvider } from "@opentelemetry/api";
import { logs as otelLogs, SeverityNumber as OtelSeverityNumber } from "@opentelemetry/api-logs";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { expect, test } from "vitest";
import { loggerProvider, meterProvider } from "./api.ts";
import { initStrada, shutdown, startSpan } from "./node.ts";
import { registerOpenTelemetry } from "./otel.ts";

type KeyValue = { key: string; value: Record<string, unknown> };
type OtlpSpan = { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number; attributes: KeyValue[] };
type OtlpLog = { spanId?: string; body?: { stringValue?: string } };
type Received<T> = { scope: string; record: T };

function attributes(list: KeyValue[]): Record<string, unknown> {
  return Object.fromEntries(list.map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? value.boolValue]));
}

test("OTel instrumentations and API users export through Strada with shared context", async () => {
  // Real OTLP/HTTP JSON receiver: the test only sees what the SDK exported.
  const spans: Array<Received<OtlpSpan>> = [];
  const logs: Array<Received<OtlpLog>> = [];
  const sink = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      for (const resource of parsed.resourceSpans ?? []) {
        for (const scope of resource.scopeSpans) spans.push(...scope.spans.map((record: OtlpSpan) => ({ scope: scope.scope.name, record })));
      }
      for (const resource of parsed.resourceLogs ?? []) {
        for (const scope of resource.scopeLogs) logs.push(...scope.logRecords.map((record: OtlpLog) => ({ scope: scope.scope.name, record })));
      }
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
  const sinkEndpoint = `http://127.0.0.1:${(sink.address() as { port: number }).port}`;
  expect(initStrada({ projectId: "", endpoint: sinkEndpoint, service: "api", enabled: true, captureUncaughtErrors: false })).toBeUndefined();
  expect(registerOpenTelemetry()).toBeUndefined();
  const disable = registerInstrumentations({ instrumentations: [new HttpInstrumentation()] });
  // Instrumentation patches the CommonJS http module when it is required after registration.
  const http = createRequire(import.meta.url)("node:http") as typeof import("node:http");

  const server = http.createServer((_req, res) => {
    // Code using the real @opentelemetry/api sees the server span as active.
    otelLogs.getLogger("app").emit({ severityNumber: OtelSeverityNumber.INFO, body: "handled" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  await startSpan({ name: "job" }, async () => {
    await new Promise<void>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/users?id=1`, (res) => {
          res.resume();
          res.on("end", resolve);
        })
        .on("error", reject);
    });
  });
  otelTrace.getTracer("lib").startSpan("from-otel-api").end();
  server.close();
  disable();
  expect(await shutdown()).toBeUndefined();
  sink.close();

  const byName = (name: string) => spans.find((span) => span.record.name === name)!;
  const job = byName("job").record;
  const client = spans.find((span) => span.record.kind === 3)!.record;
  const serverSpan = spans.find((span) => span.record.kind === 2)!.record;
  const handledLog = logs.find((log) => log.record.body?.stringValue === "handled")!;

  expect({
    scopes: [...new Set(spans.map((span) => span.scope))].sort(),
    clientParentIsJob: client.parentSpanId === job.spanId,
    // traceparent injected by the client span and extracted by the server span.
    serverParentIsClient: serverSpan.parentSpanId === client.spanId,
    oneTrace: new Set([job.traceId, client.traceId, serverSpan.traceId]).size === 1,
    logInServerSpan: handledLog.record.spanId === serverSpan.spanId,
    logScope: handledLog.scope,
    serverAttributes: attributes(serverSpan.attributes)["http.target"],
    otelApiSpan: byName("from-otel-api").scope,
  }).toMatchInlineSnapshot(`
    {
      "clientParentIsJob": true,
      "logInServerSpan": true,
      "logScope": "app",
      "oneTrace": true,
      "otelApiSpan": "lib",
      "scopes": [
        "@opentelemetry/instrumentation-http",
        "lib",
        "strada",
      ],
      "serverAttributes": "/users?id=1",
      "serverParentIsClient": true,
    }
  `);
});

test("registerOpenTelemetry is all or nothing when another OTel SDK owns a global", () => {
  for (const api of [otelTrace, otelContext, otelPropagation, otelMetrics, otelLogs]) api.disable();
  const otherSdk: TracerProvider = new ProxyTracerProvider();
  otelTrace.setGlobalTracerProvider(otherSdk);

  const error = registerOpenTelemetry();
  expect({
    error: error?.message,
    // The logger was set before the tracer failed and must be rolled back.
    loggerIsStrada: otelLogs.getLoggerProvider() === loggerProvider,
    tracerStillOther: (otelTrace.getTracerProvider() as ProxyTracerProvider).getDelegate() === otherSdk,
    meterIsStrada: otelMetrics.getMeterProvider() === meterProvider,
    propagatorFields: otelPropagation.fields(),
  }).toMatchInlineSnapshot(`
    {
      "error": "another OpenTelemetry SDK already registered the global tracer provider. Use only one OTel SDK.",
      "loggerIsStrada": false,
      "meterIsStrada": false,
      "propagatorFields": [],
      "tracerStillOther": true,
    }
  `);
  otelTrace.disable();
});
