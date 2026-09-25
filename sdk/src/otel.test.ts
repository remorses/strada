import { createServer } from "node:http";
import { createRequire } from "node:module";
import { trace as otelTrace } from "@opentelemetry/api";
import { logs as otelLogs, SeverityNumber as OtelSeverityNumber } from "@opentelemetry/api-logs";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { expect, test } from "vitest";
import { takeQueuedRecords } from "./export.ts";
import { initStrada, shutdown, startSpan } from "./node.ts";
import { registerOpenTelemetry } from "./otel.ts";

type KeyValue = { key: string; value: Record<string, unknown> };

function attributes(list: KeyValue[]): Record<string, unknown> {
  return Object.fromEntries(list.map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? value.boolValue]));
}

test("OTel instrumentations and API users export through Strada with shared context", async () => {
  // Spans and logs are read from the queue; the sink only answers the final metrics flush.
  const sink = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.end("{}"));
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

  const { spans, logs } = takeQueuedRecords();
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
    serverAttributes: attributes(serverSpan.attributes as KeyValue[])["http.target"],
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
  expect(await shutdown()).toBeUndefined();
  sink.close();
});
