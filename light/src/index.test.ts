import http from "node:http";
import { expect, test } from "vitest";
import type { ATTR as FullATTR } from "@strada.sh/sdk/src/attrs";
import type * as full from "@strada.sh/sdk/src/node";
import type {
  CaptureExceptionOptions as FullCaptureExceptionOptions,
  StradaOptions as FullStradaOptions,
  StradaUserIdentity as FullStradaUserIdentity,
  TrackPageviewOptions as FullTrackPageviewOptions,
} from "@strada.sh/sdk/src/shared";
import { ATTR } from "./attrs.ts";
import * as light from "./index.ts";

// ---------------------------------------------------------------------------
// Compile-time sync with @strada.sh/sdk. tsc fails here when the two drift.
// ---------------------------------------------------------------------------

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assignable<From, To> = [From] extends [To] ? true : false;
function assertTrue<T extends true>(): T | undefined {
  return undefined;
}

// Every light ATTR key exists in the full ATTR with the same value.
assertTrue<Equal<typeof ATTR, Pick<typeof FullATTR, keyof typeof ATTR>>>();
// Shared data types are identical.
assertTrue<Equal<light.StradaUserIdentity, FullStradaUserIdentity>>();
assertTrue<Equal<light.CaptureExceptionOptions, FullCaptureExceptionOptions>>();
assertTrue<Equal<light.TrackPageviewOptions, FullTrackPageviewOptions>>();
// Light options are a subset: same field types, fewer fields.
type LightOptionKeys = Exclude<keyof light.StradaOptions, "telemetry">;
assertTrue<Equal<Omit<light.StradaOptions, "telemetry">, Pick<FullStradaOptions, LightOptionKeys>>>();
assertTrue<Assignable<light.StradaOptions, FullStradaOptions>>();
// Every full export fits the light signature: light accepts fewer inputs and
// returns fewer members, so code written for light also compiles on full.
assertTrue<Assignable<typeof full.initStrada, typeof light.initStrada>>();
assertTrue<Assignable<typeof full.track, typeof light.track>>();
assertTrue<Assignable<typeof full.identifyUser, typeof light.identifyUser>>();
assertTrue<Assignable<typeof full.captureException, typeof light.captureException>>();
assertTrue<Assignable<typeof full.setTags, typeof light.setTags>>();
assertTrue<Assignable<typeof full.getLogger, typeof light.getLogger>>();
assertTrue<Assignable<typeof full.startSpan, typeof light.startSpan>>();
assertTrue<Assignable<typeof full.startInactiveSpan, typeof light.startInactiveSpan>>();
assertTrue<Assignable<typeof full.trackPageview, typeof light.trackPageview>>();
assertTrue<Assignable<typeof full.flush, typeof light.flush>>();
assertTrue<Assignable<typeof full.shutdown, typeof light.shutdown>>();
assertTrue<Equal<typeof light.SpanStatusCode, { readonly UNSET: 0; readonly OK: 1; readonly ERROR: 2 }>>();

test("light sends events, profiles, errors, logs, and nested spans in the full SDK shape", async () => {
  const requests: Array<{ url?: string; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      requests.push({ url: req.url, body: JSON.parse(data) });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as { port: number };

  expect(
    light.initStrada({
      projectId: "",
      endpoint: `http://127.0.0.1:${port}/`,
      service: "cli",
      version: "1.2.3",
      enabled: true,
      userId: () => "user_1",
      ignoreErrors: [/ignored/],
    }),
  ).toBeUndefined();
  light.setTags({ region: "eu" });
  expect(light.track("session_created", { kind: "extension", count: 2, ok: true })).toBeUndefined();
  expect(light.identifyUser({ id: "user_1", email: "a@b.co" })).toBeUndefined();
  expect(light.captureException(new Error("ignored by pattern"))).toBeUndefined();
  light.getLogger("jobs").warn({ message: "slow", durationMs: 928 });

  await light
    .startSpan({ name: "parent", attributes: { job: "sync" } }, async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
      light.startSpan({ name: "child" }, (span) => {
        span.setAttribute("rows", 3);
      });
      const error = new TypeError("boom");
      error.stack = "TypeError: boom\n    at x (file.ts:1:1)";
      expect(light.captureException(error, { tags: { route: "/x" } })).toBeUndefined();
      throw error;
    })
    .catch(() => undefined);
  expect(light.trackPageview({ path: "/docs", sessionId: "s1", referrer: "https://google.com" })).toBeUndefined();
  expect(await light.shutdown()).toBeUndefined();
  server.close();

  // Replace random ids and timestamps with stable placeholders, keeping parent links readable.
  const ids = new Map<string, string>();
  const normalized = JSON.parse(
    JSON.stringify(requests)
      .replace(/"\d{19}"/g, '"<time>"')
      .replace(/"([0-9a-f]{32}|[0-9a-f]{16})"/g, (_match, id: string) => {
        if (!ids.has(id)) ids.set(id, `<id${ids.size}>`);
        return `"${ids.get(id)}"`;
      }),
  );
  expect(normalized).toMatchInlineSnapshot(`
    [
      {
        "body": {
          "resourceLogs": [
            {
              "resource": {
                "attributes": [
                  {
                    "key": "service.name",
                    "value": {
                      "stringValue": "cli",
                    },
                  },
                  {
                    "key": "service.version",
                    "value": {
                      "stringValue": "1.2.3",
                    },
                  },
                ],
              },
              "scopeLogs": [
                {
                  "logRecords": [
                    {
                      "attributes": [
                        {
                          "key": "user.id",
                          "value": {
                            "stringValue": "user_1",
                          },
                        },
                        {
                          "key": "event.name",
                          "value": {
                            "stringValue": "session_created",
                          },
                        },
                        {
                          "key": "custom.kind",
                          "value": {
                            "stringValue": "extension",
                          },
                        },
                        {
                          "key": "custom.count",
                          "value": {
                            "intValue": 2,
                          },
                        },
                        {
                          "key": "custom.ok",
                          "value": {
                            "boolValue": true,
                          },
                        },
                      ],
                      "body": {
                        "stringValue": "session_created",
                      },
                      "eventName": "session_created",
                      "observedTimeUnixNano": "<time>",
                      "severityNumber": 9,
                      "severityText": "INFO",
                      "timeUnixNano": "<time>",
                    },
                    {
                      "attributes": [
                        {
                          "key": "user.id",
                          "value": {
                            "stringValue": "user_1",
                          },
                        },
                        {
                          "key": "event.name",
                          "value": {
                            "stringValue": "strada.user.identify",
                          },
                        },
                        {
                          "key": "user.email",
                          "value": {
                            "stringValue": "a@b.co",
                          },
                        },
                      ],
                      "body": {
                        "stringValue": "strada.user.identify",
                      },
                      "eventName": "strada.user.identify",
                      "observedTimeUnixNano": "<time>",
                      "severityNumber": 9,
                      "severityText": "INFO",
                      "timeUnixNano": "<time>",
                    },
                    {
                      "attributes": [
                        {
                          "key": "user.id",
                          "value": {
                            "stringValue": "user_1",
                          },
                        },
                        {
                          "key": "exception.type",
                          "value": {
                            "stringValue": "TypeError",
                          },
                        },
                        {
                          "key": "exception.message",
                          "value": {
                            "stringValue": "boom",
                          },
                        },
                        {
                          "key": "exception.stacktrace",
                          "value": {
                            "stringValue": "TypeError: boom
        at x (file.ts:1:1)",
                          },
                        },
                        {
                          "key": "exception.mechanism.type",
                          "value": {
                            "stringValue": "generic",
                          },
                        },
                        {
                          "key": "exception.mechanism.handled",
                          "value": {
                            "stringValue": "true",
                          },
                        },
                        {
                          "key": "region",
                          "value": {
                            "stringValue": "eu",
                          },
                        },
                        {
                          "key": "route",
                          "value": {
                            "stringValue": "/x",
                          },
                        },
                      ],
                      "body": {
                        "stringValue": "boom",
                      },
                      "eventName": "exception",
                      "observedTimeUnixNano": "<time>",
                      "severityNumber": 17,
                      "severityText": "ERROR",
                      "spanId": "<id1>",
                      "timeUnixNano": "<time>",
                      "traceId": "<id0>",
                    },
                  ],
                  "scope": {
                    "name": "strada",
                  },
                },
                {
                  "logRecords": [
                    {
                      "attributes": [
                        {
                          "key": "user.id",
                          "value": {
                            "stringValue": "user_1",
                          },
                        },
                        {
                          "key": "message",
                          "value": {
                            "stringValue": "slow",
                          },
                        },
                        {
                          "key": "durationMs",
                          "value": {
                            "intValue": 928,
                          },
                        },
                      ],
                      "body": {
                        "stringValue": "slow",
                      },
                      "observedTimeUnixNano": "<time>",
                      "severityNumber": 13,
                      "severityText": "WARN",
                      "timeUnixNano": "<time>",
                    },
                  ],
                  "scope": {
                    "name": "jobs",
                  },
                },
              ],
            },
          ],
        },
        "url": "/v1/logs",
      },
      {
        "body": {
          "resourceSpans": [
            {
              "resource": {
                "attributes": [
                  {
                    "key": "service.name",
                    "value": {
                      "stringValue": "cli",
                    },
                  },
                  {
                    "key": "service.version",
                    "value": {
                      "stringValue": "1.2.3",
                    },
                  },
                ],
              },
              "scopeSpans": [
                {
                  "scope": {
                    "name": "strada",
                  },
                  "spans": [
                    {
                      "attributes": [
                        {
                          "key": "user.id",
                          "value": {
                            "stringValue": "user_1",
                          },
                        },
                        {
                          "key": "rows",
                          "value": {
                            "intValue": 3,
                          },
                        },
                      ],
                      "endTimeUnixNano": "<time>",
                      "events": [],
                      "kind": 1,
                      "name": "child",
                      "parentSpanId": "<id1>",
                      "spanId": "<id2>",
                      "startTimeUnixNano": "<time>",
                      "status": {
                        "code": 0,
                      },
                      "traceId": "<id0>",
                    },
                    {
                      "attributes": [
                        {
                          "key": "user.id",
                          "value": {
                            "stringValue": "user_1",
                          },
                        },
                        {
                          "key": "job",
                          "value": {
                            "stringValue": "sync",
                          },
                        },
                      ],
                      "endTimeUnixNano": "<time>",
                      "events": [
                        {
                          "attributes": [
                            {
                              "key": "exception.type",
                              "value": {
                                "stringValue": "TypeError",
                              },
                            },
                            {
                              "key": "exception.message",
                              "value": {
                                "stringValue": "boom",
                              },
                            },
                            {
                              "key": "exception.stacktrace",
                              "value": {
                                "stringValue": "TypeError: boom
        at x (file.ts:1:1)",
                              },
                            },
                          ],
                          "name": "exception",
                          "timeUnixNano": "<time>",
                        },
                      ],
                      "kind": 1,
                      "name": "parent",
                      "spanId": "<id1>",
                      "startTimeUnixNano": "<time>",
                      "status": {
                        "code": 2,
                      },
                      "traceId": "<id0>",
                    },
                    {
                      "attributes": [
                        {
                          "key": "user.id",
                          "value": {
                            "stringValue": "user_1",
                          },
                        },
                        {
                          "key": "url.path",
                          "value": {
                            "stringValue": "/docs",
                          },
                        },
                        {
                          "key": "pageview.source",
                          "value": {
                            "stringValue": "server",
                          },
                        },
                        {
                          "key": "session.id",
                          "value": {
                            "stringValue": "s1",
                          },
                        },
                        {
                          "key": "http.request.header.referer",
                          "value": {
                            "stringValue": "https://google.com",
                          },
                        },
                      ],
                      "endTimeUnixNano": "<time>",
                      "events": [],
                      "kind": 1,
                      "name": "pageview",
                      "spanId": "<id4>",
                      "startTimeUnixNano": "<time>",
                      "status": {
                        "code": 0,
                      },
                      "traceId": "<id3>",
                    },
                  ],
                },
              ],
            },
          ],
        },
        "url": "/v1/traces",
      },
    ]
  `);
});

test("light reuses keep-alive connections across flushes", async () => {
  const sockets = new Set<number>();
  const server = http.createServer((req, res) => {
    sockets.add(req.socket.remotePort ?? 0);
    req.resume();
    req.on("end", () => {
      // A body larger than one chunk: an unread response body would pin the socket.
      res.end(JSON.stringify({ partialSuccess: {}, padding: "x".repeat(256 * 1024) }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as { port: number };

  expect(light.initStrada({ projectId: "", endpoint: `http://127.0.0.1:${port}`, service: "cli", enabled: true })).toBeUndefined();
  const socketsAfterRound: number[] = [];
  for (const round of [1, 2, 3]) {
    expect(light.track("round", { round })).toBeUndefined();
    expect(light.trackPageview({ path: `/${round}`, sessionId: "s" })).toBeUndefined();
    expect(await light.flush()).toBeUndefined();
    socketsAfterRound.push(sockets.size);
  }
  expect(await light.shutdown()).toBeUndefined();
  server.close();
  // Round 1 may open one socket per endpoint; later flushes must reuse them.
  expect(socketsAfterRound).toMatchInlineSnapshot(`
    [
      2,
      2,
      2,
    ]
  `);
});
