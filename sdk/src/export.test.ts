import http from "node:http";
import { afterEach, expect, test } from "vitest";
import {
  captureException,
  flush,
  getLogger,
  initStrada,
  metrics,
  shutdown,
  startSpan,
  track,
} from "./node.ts";
import { resetContext } from "./shared.ts";

/** Real OTLP/HTTP JSON receiver. Records every request body and the client socket. */
async function startReceiver() {
  const requests: Array<{ url: string; port: number; body: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      requests.push({ url: req.url ?? "", port: req.socket.remotePort ?? 0, body: JSON.parse(data) });
      // Larger than one chunk: an unread response body would pin the socket.
      res.end(JSON.stringify({ partialSuccess: {}, padding: "x".repeat(128 * 1024) }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as { port: number };
  return { requests, endpoint: `http://127.0.0.1:${port}`, close: () => server.close() };
}

type KeyValue = { key: string; value: Record<string, unknown> };

function decodeAttributes(list: KeyValue[] | undefined): Record<string, unknown> {
  return Object.fromEntries(
    (list ?? []).map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue ?? value]),
  );
}

afterEach(() => {
  resetContext();
});

test("exports events, errors, logs, and nested async spans in one request per signal", async () => {
  const receiver = await startReceiver();
  expect(
    initStrada({
      projectId: "",
      endpoint: receiver.endpoint,
      service: "cli",
      version: "1.2.3",
      token: "secret",
      enabled: true,
      captureUncaughtErrors: false,
      ignoreErrors: [/ignored/],
    }),
  ).toBeUndefined();

  expect(track("session_created", { kind: "extension", count: 2 })).toBeUndefined();
  expect(captureException(new Error("ignored by pattern"))).toBeUndefined();
  getLogger("jobs").warn({ message: "slow", durationMs: 928 });
  await startSpan({ name: "parent", attributes: { job: "sync" } }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    startSpan({ name: "child" }, (span) => {
      span.setAttribute("rows", 3);
    });
    const error = new TypeError("boom");
    error.stack = "TypeError: boom\n    at x (file.ts:1:1)";
    expect(captureException(error, { tags: { route: "/x" } })).toBeUndefined();
  });
  expect(await flush()).toBeUndefined();
  expect(await shutdown()).toBeUndefined();
  receiver.close();

  const logs = receiver.requests.filter((request) => request.url === "/v1/logs");
  const traces = receiver.requests.filter((request) => request.url === "/v1/traces");
  expect({ logs: logs.length, traces: traces.length }).toMatchInlineSnapshot(`
    {
      "logs": 1,
      "traces": 1,
    }
  `);

  const resourceLogs = (logs[0]!.body.resourceLogs as Array<Record<string, any>>)[0]!;
  expect(decodeAttributes(resourceLogs.resource.attributes)).toMatchInlineSnapshot(`
    {
      "service.name": "cli",
      "service.version": "1.2.3",
      "telemetry.sdk.language": "javascript",
      "telemetry.sdk.name": "strada",
    }
  `);
  const logRecords = (resourceLogs.scopeLogs as Array<Record<string, any>>).flatMap((scopeLog) =>
    (scopeLog.logRecords as Array<Record<string, any>>).map((record) => ({
      scope: scopeLog.scope.name,
      eventName: record.eventName,
      severity: record.severityText,
      body: record.body.stringValue,
      inSpan: Boolean(record.spanId),
      attributes: decodeAttributes(record.attributes),
    })),
  );
  expect(logRecords).toMatchInlineSnapshot(`
    [
      {
        "attributes": {
          "custom.count": 2,
          "custom.kind": "extension",
          "event.name": "session_created",
        },
        "body": "session_created",
        "eventName": "session_created",
        "inSpan": false,
        "scope": "strada",
        "severity": "INFO",
      },
      {
        "attributes": {
          "exception.mechanism.handled": "true",
          "exception.mechanism.type": "generic",
          "exception.message": "boom",
          "exception.stacktrace": "TypeError: boom
        at x (file.ts:1:1)",
          "exception.type": "TypeError",
          "route": "/x",
        },
        "body": "boom",
        "eventName": "exception",
        "inSpan": true,
        "scope": "strada",
        "severity": "ERROR",
      },
      {
        "attributes": {
          "durationMs": 928,
          "message": "slow",
        },
        "body": "slow",
        "eventName": undefined,
        "inSpan": false,
        "scope": "jobs",
        "severity": "WARN",
      },
    ]
  `);

  const spans = ((traces[0]!.body.resourceSpans as Array<Record<string, any>>)[0]!.scopeSpans[0].spans as Array<Record<string, any>>);
  const parent = spans.find((span) => span.name === "parent")!;
  const child = spans.find((span) => span.name === "child")!;
  expect({
    childParentIsParent: child.parentSpanId === parent.spanId,
    sameTrace: child.traceId === parent.traceId,
    parentHasNoParent: parent.parentSpanId === undefined,
    childAttributes: decodeAttributes(child.attributes),
  }).toMatchInlineSnapshot(`
    {
      "childAttributes": {
        "rows": 3,
      },
      "childParentIsParent": true,
      "parentHasNoParent": true,
      "sameTrace": true,
    }
  `);
});

test("exports cumulative metrics as OTLP JSON", async () => {
  const receiver = await startReceiver();
  expect(initStrada({ projectId: "", endpoint: receiver.endpoint, service: "cli", enabled: true, captureUncaughtErrors: false })).toBeUndefined();
  const meter = metrics.getMeter("jobs");
  const counter = meter.createCounter("jobs.done", { unit: "1" });
  const histogram = meter.createHistogram("jobs.duration", { unit: "ms", advice: { explicitBucketBoundaries: [10, 100] } });
  const queue = meter.createObservableGauge("jobs.queue");
  queue.addCallback((result) => {
    result.observe(7, { queue: "default" });
  });
  counter.add(2, { status: "ok" });
  counter.add(3, { status: "ok" });
  counter.add(-1, { status: "ok" });
  histogram.record(5);
  histogram.record(50);
  histogram.record(500);
  expect(await flush()).toBeUndefined();
  expect(await shutdown()).toBeUndefined();
  receiver.close();

  const body = receiver.requests.find((request) => request.url === "/v1/metrics")!.body;
  const exported = ((body.resourceMetrics as Array<Record<string, any>>)[0]!.scopeMetrics as Array<Record<string, any>>)
    .filter((scope) => scope.scope.name === "jobs")
    .flatMap((scope) => scope.metrics as Array<Record<string, any>>)
    .map((metric) => {
      const data = metric.sum ?? metric.gauge ?? metric.histogram;
      return {
        name: metric.name,
        type: metric.sum ? "sum" : metric.gauge ? "gauge" : "histogram",
        monotonic: metric.sum?.isMonotonic,
        points: (data.dataPoints as Array<Record<string, any>>).map(({ attributes, startTimeUnixNano, timeUnixNano, ...rest }) => ({
          attributes: decodeAttributes(attributes),
          ...rest,
        })),
      };
    });
  expect(exported).toMatchInlineSnapshot(`
    [
      {
        "monotonic": true,
        "name": "jobs.done",
        "points": [
          {
            "asInt": "5",
            "attributes": {
              "status": "ok",
            },
          },
        ],
        "type": "sum",
      },
      {
        "monotonic": undefined,
        "name": "jobs.duration",
        "points": [
          {
            "attributes": {},
            "bucketCounts": [
              "1",
              "1",
              "1",
            ],
            "count": "3",
            "explicitBounds": [
              10,
              100,
            ],
            "max": 500,
            "min": 5,
            "sum": 555,
          },
        ],
        "type": "histogram",
      },
      {
        "monotonic": undefined,
        "name": "jobs.queue",
        "points": [
          {
            "asInt": "7",
            "attributes": {
              "queue": "default",
            },
          },
        ],
        "type": "gauge",
      },
    ]
  `);
});

test("reuses keep-alive connections across flushes", async () => {
  const receiver = await startReceiver();
  expect(initStrada({ projectId: "", endpoint: receiver.endpoint, service: "cli", enabled: true, captureUncaughtErrors: false })).toBeUndefined();
  const socketsAfterRound: number[] = [];
  for (const round of [1, 2, 3]) {
    expect(track("round", { round })).toBeUndefined();
    startSpan({ name: `round-${round}` }, () => undefined);
    expect(await flush()).toBeUndefined();
    socketsAfterRound.push(new Set(receiver.requests.map((request) => request.port)).size);
  }
  expect(await shutdown()).toBeUndefined();
  receiver.close();
  // Round 1 may open one socket per endpoint; later flushes must reuse them.
  expect(socketsAfterRound).toMatchInlineSnapshot(`
    [
      2,
      2,
      2,
    ]
  `);
});
