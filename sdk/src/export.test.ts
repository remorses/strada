import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { Redis } from "ioredis";
import mongoose from "mongoose";
import mysql from "mysql2";
import { createClient } from "redis";
import { afterEach, expect, test } from "vitest";
import {
  captureException,
  flush,
  getLogger,
  initStrada,
  logs,
  metrics,
  shutdown,
  startSpan,
  track,
} from "./node.ts";
import { fetchSpans, httpClientSpans, httpServerSpans, mongooseSpans, mysql2Spans, redisSpans } from "./instrument.ts";
import { flush as flushPipeline, startPipeline, stopPipeline } from "./export.ts";
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
  const firstSessionRequests = receiver.requests.length;

  // A second session must not re-export the first session's cumulative series.
  expect(initStrada({ projectId: "", endpoint: receiver.endpoint, service: "cli", enabled: true, captureUncaughtErrors: false })).toBeUndefined();
  counter.add(1, { status: "ok" });
  expect(await shutdown()).toBeUndefined();
  receiver.close();
  const secondSession = receiver.requests
    .slice(firstSessionRequests)
    .filter((request) => request.url === "/v1/metrics")
    .flatMap((request) => (request.body.resourceMetrics as Array<Record<string, any>>)[0]!.scopeMetrics as Array<Record<string, any>>)
    .filter((scope) => scope.scope.name === "jobs")
    .flatMap((scope) => (scope.metrics as Array<Record<string, any>>).map((metric) => `${metric.name}=${JSON.stringify(metric.sum?.dataPoints.map((point: { asInt: string }) => point.asInt))}`));
  expect(secondSession).toMatchInlineSnapshot(`
    [
      "jobs.done=["1"]",
      "jobs.queue=undefined",
    ]
  `);

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

test("invocation-scoped pipeline: flushes never wait on each other, metrics send only changed series", async () => {
  const receiver = await startReceiver();
  // A second server that holds its response until released, like a slow export from another request.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = http.createServer((req, res) => {
    req.resume();
    void held.then(() => res.end("{}"));
  });
  await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
  const batch = { scheduledDelayMillis: 60_000, maxExportBatchSize: 512, maxQueueSize: 2048, exportTimeoutMillis: 5000 };
  const pipeline = (endpoint: string) => ({
    endpoint,
    headers: {},
    resource: [],
    logs: batch,
    traces: batch,
    metrics: { exportIntervalMillis: 60_000, exportTimeoutMillis: 5000 },
    invocationScoped: true,
  });

  startPipeline(pipeline(`http://127.0.0.1:${(slow.address() as { port: number }).port}`));
  logs.getLogger("a").emit({ body: "request A" });
  const flushA = flushPipeline({ includeMetrics: false });
  startPipeline(pipeline(receiver.endpoint));
  logs.getLogger("b").emit({ body: "request B" });
  const flushB = await flushPipeline({ includeMetrics: false });

  const counter = metrics.getMeter("invocation").createCounter("invocation.count");
  const metricPoints = async () => {
    const before = receiver.requests.length;
    expect(await flushPipeline()).toBeUndefined();
    return receiver.requests
      .slice(before)
      .filter((request) => request.url === "/v1/metrics")
      .flatMap((request) => (request.body.resourceMetrics as Array<Record<string, any>>)[0]!.scopeMetrics as Array<Record<string, any>>)
      .filter((scope) => scope.scope.name === "invocation")
      .flatMap((scope) => (scope.metrics as Array<Record<string, any>>).flatMap((metric) => metric.sum.dataPoints.map((point: { asInt: string }) => point.asInt)));
  };
  counter.add(2);
  const first = await metricPoints();
  const unchanged = await metricPoints();
  counter.add(3);
  const cumulative = await metricPoints();

  const bFinishedWhileAPending = receiver.requests.some((request) => request.url === "/v1/logs");
  release();
  const errorA = await flushA;
  stopPipeline();
  slow.close();
  receiver.close();
  expect({ flushB, bFinishedWhileAPending, errorA, first, unchanged, cumulative }).toMatchInlineSnapshot(`
    {
      "bFinishedWhileAPending": true,
      "cumulative": [
        "5",
      ],
      "errorA": undefined,
      "first": [
        "2",
      ],
      "flushB": undefined,
      "unchanged": [],
    }
  `);
});

test("shutdown removes process handlers so a later init can choose again", async () => {
  const receiver = await startReceiver();
  const count = () => process.listenerCount("uncaughtException");
  const before = count();
  const counts: number[] = [];
  for (const captureUncaughtErrors of [false, true, false]) {
    expect(initStrada({ projectId: "", endpoint: receiver.endpoint, service: "cli", enabled: true, captureUncaughtErrors })).toBeUndefined();
    counts.push(count() - before);
    expect(await shutdown()).toBeUndefined();
  }
  counts.push(count() - before);
  receiver.close();
  expect(counts).toMatchInlineSnapshot(`
    [
      0,
      1,
      0,
      0,
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

test("integrations: fetch, http-client, http-server spans link through traceparent without patching", async () => {
  const receiver = await startReceiver();
  expect(
    initStrada({
      projectId: "",
      endpoint: receiver.endpoint,
      service: "api",
      enabled: true,
      captureUncaughtErrors: false,
      integrations: [fetchSpans(), httpClientSpans(), httpServerSpans()],
    }),
  ).toBeUndefined();
  const app = http.createServer((req, res) => {
    getLogger("handler").info(`handled ${req.url}`);
    res.statusCode = req.url === "/missing" ? 404 : 200;
    res.end("ok");
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;

  await startSpan({ name: "job" }, async () => {
    await (await fetch(`${base}/via-fetch?x=1`)).text();
    await new Promise<void>((resolve) => {
      http.get(`${base}/missing`, (res) => {
        res.resume();
        res.on("end", resolve);
      });
    });
  });
  // The server span ends on 'close', after the client already got the response.
  await new Promise((resolve) => setTimeout(resolve, 20));
  app.close();
  expect(await shutdown()).toBeUndefined();
  receiver.close();

  type Span = { name: string; kind: number; spanId: string; parentSpanId?: string; attributes: KeyValue[]; status: { code: number } };
  const spans = receiver.requests
    .filter((request) => request.url === "/v1/traces")
    .flatMap((request) => (request.body.resourceSpans as Array<{ scopeSpans: Array<{ spans: Span[] }> }>)[0]!.scopeSpans.flatMap((scope) => scope.spans));
  const logs = receiver.requests
    .filter((request) => request.url === "/v1/logs")
    .flatMap((request) => (request.body.resourceLogs as Array<{ scopeLogs: Array<{ logRecords: Array<{ spanId?: string; body: { stringValue: string } }> }> }>)[0]!.scopeLogs.flatMap((scope) => scope.logRecords));
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const describe = (span: Span | undefined): string => {
    if (!span) return "none";
    const attrs = decodeAttributes(span.attributes);
    const kind = ["", "internal", "server", "client"][span.kind];
    return `${kind} ${span.name} ${attrs["url.full"] ?? attrs["url.path"] ?? ""} ${attrs["http.response.status_code"] ?? ""} status=${span.status.code}`.replace(/127\.0\.0\.1:\d+/, "app");
  };
  expect({
    spans: spans.map((span) => `${describe(span)} <- ${describe(byId.get(span.parentSpanId ?? ""))}`).sort(),
    logsInServerSpan: logs.map((log) => `${log.body.stringValue} in ${describe(byId.get(log.spanId ?? ""))}`).sort(),
    exportRequestsTraced: spans.some((span) => String(decodeAttributes(span.attributes)["url.full"] ?? "").includes("/v1/")),
  }).toMatchInlineSnapshot(`
    {
      "exportRequestsTraced": false,
      "logsInServerSpan": [
        "handled /missing in server GET /missing 404 status=0",
        "handled /via-fetch?x=1 in server GET /via-fetch 200 status=0",
      ],
      "spans": [
        "client GET http://app/missing 404 status=2 <- internal job   status=0",
        "client GET http://app/via-fetch?x=1 200 status=0 <- internal job   status=0",
        "internal job   status=0 <- none",
        "server GET /missing 404 status=0 <- client GET http://app/missing 404 status=2",
        "server GET /via-fetch 200 status=0 <- client GET http://app/via-fetch?x=1 200 status=0",
      ],
    }
  `);
});

/** Free TCP port: listen on 0, read it, close. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("integrations: mysql2, redis, ioredis, mongoose TracingChannel spans parent to the active span", async () => {
  const receiver = await startReceiver();
  const redisPort = await freePort();
  const redisServer = spawn("redis-server", ["--port", String(redisPort), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"]);
  await new Promise<void>((resolve, reject) => {
    redisServer.on("error", reject);
    redisServer.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Ready to accept connections")) resolve();
    });
  });
  expect(
    initStrada({
      projectId: "",
      endpoint: receiver.endpoint,
      service: "api",
      enabled: true,
      captureUncaughtErrors: false,
      integrations: [mysql2Spans(), redisSpans(), mongooseSpans()],
    }),
  ).toBeUndefined();

  const redis = new Redis({ host: "127.0.0.1", port: redisPort, lazyConnect: true });
  await redis.connect();
  const nodeRedis = createClient({ socket: { host: "127.0.0.1", port: redisPort } });
  await nodeRedis.connect();
  // No MongoDB server: with bufferCommands off, operations fail right away but still publish.
  const mongo = mongoose.createConnection();
  const User = mongo.model("User", new mongoose.Schema({ email: String }, { bufferCommands: false }));
  // No MySQL server: the query is still published, then fails with ECONNREFUSED.
  const mysqlConnection = mysql.createConnection({ host: "127.0.0.1", port: await freePort(), database: "shop" });
  mysqlConnection.on("error", () => {});
  await startSpan({ name: "job" }, async () => {
    await redis.set("user:1", "secret-value");
    await redis.get("user:1");
    await redis.multi().incr("visits").expire("visits", 60).exec();
    await nodeRedis.hSet("session:1", "token", "secret-value");
    await nodeRedis.multi().incr("hits").get("hits").exec();
    await User.find({ email: "a@b.co" }).exec().catch(() => undefined);
    const failed = await new Promise<unknown>((resolve) => {
      mysqlConnection.query("SELECT * FROM users WHERE email = ? AND id = 42", ["a@b.co"], (error) => resolve(error));
    });
    expect(failed).toBeInstanceOf(Error);
  });
  redis.disconnect();
  await nodeRedis.quit();
  redisServer.kill();
  expect(await shutdown()).toBeUndefined();
  receiver.close();

  type Span = { name: string; kind: number; spanId: string; parentSpanId?: string; attributes: KeyValue[]; status: { code: number } };
  const spans = receiver.requests
    .filter((request) => request.url === "/v1/traces")
    .flatMap((request) => (request.body.resourceSpans as Array<{ scopeSpans: Array<{ spans: Span[] }> }>)[0]!.scopeSpans.flatMap((scope) => scope.spans));
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  // Commands ioredis sends on its own while connecting (INFO) have no parent.
  const traced = spans.filter((span) => byId.get(span.parentSpanId ?? "")?.name === "job");
  expect(
    traced.map((span) => {
      const { "server.port": _port, ...attributes } = decodeAttributes(span.attributes);
      return { name: span.name, kind: span.kind, status: span.status.code, attributes };
    }),
  ).toMatchInlineSnapshot(`
    [
      {
        "attributes": {
          "db.namespace": "0",
          "db.operation.name": "SET",
          "db.query.text": "SET user:1 ?",
          "db.system.name": "redis",
          "server.address": "127.0.0.1",
        },
        "kind": 3,
        "name": "SET 0",
        "status": 0,
      },
      {
        "attributes": {
          "db.namespace": "0",
          "db.operation.name": "GET",
          "db.query.text": "GET user:1",
          "db.system.name": "redis",
          "server.address": "127.0.0.1",
        },
        "kind": 3,
        "name": "GET 0",
        "status": 0,
      },
      {
        "attributes": {
          "db.namespace": "0",
          "db.operation.name": "MULTI",
          "db.query.text": "MULTI",
          "db.system.name": "redis",
          "server.address": "127.0.0.1",
        },
        "kind": 3,
        "name": "MULTI 0",
        "status": 0,
      },
      {
        "attributes": {
          "db.namespace": "0",
          "db.operation.name": "INCR",
          "db.query.text": "INCR visits",
          "db.system.name": "redis",
          "server.address": "127.0.0.1",
        },
        "kind": 3,
        "name": "INCR 0",
        "status": 0,
      },
      {
        "attributes": {
          "db.namespace": "0",
          "db.operation.name": "EXPIRE",
          "db.query.text": "EXPIRE visits 60",
          "db.system.name": "redis",
          "server.address": "127.0.0.1",
        },
        "kind": 3,
        "name": "EXPIRE 0",
        "status": 0,
      },
      {
        "attributes": {
          "db.namespace": "0",
          "db.operation.name": "EXEC",
          "db.query.text": "EXEC",
          "db.system.name": "redis",
          "server.address": "127.0.0.1",
        },
        "kind": 3,
        "name": "EXEC 0",
        "status": 0,
      },
      {
        "attributes": {
          "db.namespace": "0",
          "db.operation.name": "HSET",
          "db.query.text": "HSET session:1 token ?",
          "db.system.name": "redis",
          "server.address": "127.0.0.1",
        },
        "kind": 3,
        "name": "HSET 0",
        "status": 0,
      },
      {
        "attributes": {
          "db.namespace": "0",
          "db.operation.batch.size": 2,
          "db.operation.name": "MULTI",
          "db.system.name": "redis",
          "server.address": "127.0.0.1",
        },
        "kind": 3,
        "name": "MULTI 0",
        "status": 0,
      },
      {
        "attributes": {
          "db.collection.name": "users",
          "db.operation.name": "find",
          "db.query.text": "{"email":"a@b.co"}",
          "db.system.name": "mongodb",
          "error.type": "MongooseError",
        },
        "kind": 3,
        "name": "find users",
        "status": 2,
      },
      {
        "attributes": {
          "db.namespace": "shop",
          "db.operation.name": "SELECT",
          "db.query.text": "SELECT * FROM users WHERE email = 'a@b.co' AND id = 42",
          "db.system.name": "mysql",
          "error.type": "Error",
          "server.address": "127.0.0.1",
        },
        "kind": 3,
        "name": "SELECT shop",
        "status": 2,
      },
    ]
  `);
});
