import { describe, it, expect } from "vitest";
import {
  extractErrorsFromLogs,
  extractErrorsFromTraces,
  stripDynamicValues,
  computeDefaultFingerprint,
  hashFingerprint,
} from "./extract-errors.ts";
import type { ExportLogsServiceRequest, ExportTraceServiceRequest } from "./otlp-types.ts";

describe("stripDynamicValues", () => {
  it("replaces numbers", () => {
    expect(stripDynamicValues("Connection refused on port 5432")).toBe("Connection refused on port <N>");
  });

  it("replaces UUIDs", () => {
    expect(stripDynamicValues("Request 550e8400-e29b-41d4-a716-446655440000 failed")).toBe("Request <uuid> failed");
  });

  it("replaces hex strings", () => {
    expect(stripDynamicValues("Error at 0xdeadbeef")).toBe("Error at <hex>");
    expect(stripDynamicValues("Hash abcdef0123456789 not found")).toBe("Hash <hex> not found");
  });

  it("replaces IP addresses", () => {
    expect(stripDynamicValues("Connection to 192.168.1.42 refused")).toBe("Connection to <N>.<N>.<N>.<N> refused");
  });

  it("handles mixed dynamic values", () => {
    expect(stripDynamicValues("User 550e8400-e29b-41d4-a716-446655440000 made 42 requests to 10.0.0.1")).toBe(
      "User <uuid> made <N> requests to <N>.<N>.<N>.<N>",
    );
  });

  it("leaves static messages unchanged", () => {
    expect(stripDynamicValues("Cannot read property of null")).toBe("Cannot read property of null");
  });
});

describe("computeDefaultFingerprint", () => {
  it("uses type + first in-app frame function (innermost) when structured frames available", () => {
    const frames = JSON.stringify([
      { filename: "node_modules/lib.js", function: "libFn", in_app: false },
      { filename: "src/app.js", function: "processOrder", in_app: true },
      { filename: "src/utils.js", function: "validate", in_app: true },
    ]);
    expect(computeDefaultFingerprint("TypeError", "x is null", frames)).toEqual(["TypeError", "processOrder"]);
  });

  it("falls back to type + stripped message when no in-app frames", () => {
    const frames = JSON.stringify([{ filename: "node_modules/lib.js", function: "libFn", in_app: false }]);
    expect(computeDefaultFingerprint("TypeError", "Error at row 42", frames)).toEqual([
      "TypeError",
      "Error at row <N>",
    ]);
  });

  it("falls back to type + stripped message when no structured frames", () => {
    expect(computeDefaultFingerprint("ValueError", "Invalid port 8080", "")).toEqual([
      "ValueError",
      "Invalid port <N>",
    ]);
  });

  it("uses type alone when no message", () => {
    expect(computeDefaultFingerprint("TypeError", "", "")).toEqual(["TypeError"]);
  });

  it("uses stripped message alone when no type", () => {
    expect(computeDefaultFingerprint("", "Connection refused on port 5432", "")).toEqual([
      "Connection refused on port <N>",
    ]);
  });

  it("returns unknown when neither type nor message", () => {
    expect(computeDefaultFingerprint("", "", "")).toEqual(["unknown"]);
  });

  it("handles invalid JSON in structured frames gracefully", () => {
    expect(computeDefaultFingerprint("TypeError", "test error", "not-json")).toEqual(["TypeError", "test error"]);
  });
});

describe("hashFingerprint", () => {
  it("produces consistent 32-char hex hash", () => {
    const hash = hashFingerprint(["TypeError", "processOrder"]);
    expect(hash).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    // Same input = same hash
    expect(hashFingerprint(["TypeError", "processOrder"])).toBe(hash);
  });

  it("produces different hashes for different inputs", () => {
    const h1 = hashFingerprint(["TypeError", "processOrder"]);
    const h2 = hashFingerprint(["ValueError", "processOrder"]);
    const h3 = hashFingerprint(["TypeError", "handleRequest"]);
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

describe("project-scoped fingerprint_hash", () => {
  it("same fingerprint in different projects produces different hashes", () => {
    const makeInput = (): ExportLogsServiceRequest => ({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1000000000",
                  attributes: [
                    { key: "exception.type", value: { stringValue: "DbError" } },
                    { key: "exception.message", value: { stringValue: "connection timeout" } },
                    { key: "exception.fingerprint", value: { stringValue: '["db-timeout"]' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const row1 = JSON.parse(extractErrorsFromLogs(makeInput(), "project-aaa").trim());
    const row2 = JSON.parse(extractErrorsFromLogs(makeInput(), "project-bbb").trim());

    // stored fingerprint is identical (user-facing, no project prefix)
    expect(row1.fingerprint).toEqual(["db-timeout"]);
    expect(row2.fingerprint).toEqual(["db-timeout"]);

    // but the hash differs because projectId is prefixed before hashing
    expect(row1.fingerprint_hash).not.toBe(row2.fingerprint_hash);
    expect(row1.fingerprint_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(row2.fingerprint_hash).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("extractErrorsFromLogs", () => {
  it("returns empty string when no exceptions in logs", () => {
    const input: ExportLogsServiceRequest = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1000000000",
                  severityText: "INFO",
                  body: { stringValue: "Normal log" },
                  attributes: [{ key: "user.id", value: { stringValue: "123" } }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(extractErrorsFromLogs(input, "acme")).toBe("");
  });

  it("returns empty string for empty request", () => {
    expect(extractErrorsFromLogs({}, "acme")).toBe("");
    expect(extractErrorsFromLogs({ resourceLogs: [] }, "acme")).toBe("");
  });

  it("extracts error from log with exception.type", () => {
    const input: ExportLogsServiceRequest = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "my-api" } },
              { key: "service.version", value: { stringValue: "1.2.3" } },
              {
                key: "deployment.environment.name",
                value: { stringValue: "production" },
              },
            ],
          },
          scopeLogs: [
            {
              scope: {
                name: "error-logger",
                attributes: [{ key: "scope.key", value: { stringValue: "val" } }],
              },
              logRecords: [
                {
                  timeUnixNano: "1544712660123456789",
                  severityNumber: 17,
                  severityText: "ERROR",
                  body: { stringValue: "TypeError: x is null" },
                  traceId: "trace-abc",
                  spanId: "span-def",
                  attributes: [
                    {
                      key: "exception.type",
                      value: { stringValue: "TypeError" },
                    },
                    {
                      key: "exception.message",
                      value: { stringValue: "x is null" },
                    },
                    {
                      key: "exception.stacktrace",
                      value: {
                        stringValue: "TypeError: x is null\n  at foo (app.js:42)",
                      },
                    },
                    {
                      key: "exception.mechanism.type",
                      value: { stringValue: "onerror" },
                    },
                    {
                      key: "exception.mechanism.handled",
                      value: { stringValue: "false" },
                    },
                    {
                      key: "request.url",
                      value: { stringValue: "/api/users" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const ndjson = extractErrorsFromLogs(input, "acme");
    const row = JSON.parse(ndjson.trim());

    expect(row.project_id).toBe("acme");
    expect(row.service_name).toBe("my-api");
    expect(row.exception_type).toBe("TypeError");
    expect(row.exception_message).toBe("x is null");
    expect(row.exception_stacktrace).toBe("TypeError: x is null\n  at foo (app.js:42)");
    expect(row.mechanism_type).toBe("onerror");
    expect(row.mechanism_handled).toBe(false);
    expect(row.release).toBe("1.2.3");
    expect(row.environment).toBe("production");
    expect(row.trace_id).toBe("trace-abc");
    expect(row.span_id).toBe("span-def");
    expect(row.source_signal).toBe("log");
    expect(row.level).toBe("error");
    expect(row.fingerprint).toBeInstanceOf(Array);
    expect(row.fingerprint_hash).toMatch(/^[0-9a-f]{32}$/);
    // Tags should contain non-exception attributes
    expect(row.tags["request.url"]).toBe("/api/users");
    expect(row.tags["exception.type"]).toBeUndefined();
  });

  it("uses SDK-provided fingerprint when available", () => {
    const input: ExportLogsServiceRequest = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1000000000",
                  attributes: [
                    {
                      key: "exception.type",
                      value: { stringValue: "DbError" },
                    },
                    {
                      key: "exception.message",
                      value: { stringValue: "connection timeout" },
                    },
                    {
                      key: "exception.fingerprint",
                      value: {
                        stringValue: '["db-timeout","users-service"]',
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const ndjson = extractErrorsFromLogs(input, "acme");
    const row = JSON.parse(ndjson.trim());
    expect(row.fingerprint).toEqual(["db-timeout", "users-service"]);
  });

  it("parses stacktrace frames during ingest when structured frames are absent", () => {
    const input: ExportLogsServiceRequest = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1000000000",
                  attributes: [
                    {
                      key: "exception.type",
                      value: { stringValue: "TypeError" },
                    },
                    {
                      key: "exception.message",
                      value: { stringValue: "x is null" },
                    },
                    {
                      key: "exception.stacktrace",
                      value: {
                        stringValue:
                          "TypeError: x is null\n    at processOrder (/app/src/order.js:42:15)\n    at main (/app/src/main.js:10:3)",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const ndjson = extractErrorsFromLogs(input, "acme");
    const row = JSON.parse(ndjson.trim());
    const frames = JSON.parse(row.exception_frames);

    expect(frames).toHaveLength(2);
    // With fromOtel: true, JS frames are NOT reversed (OTel sends them in correct order)
    expect(frames[0]).toMatchObject({
      function: "processOrder",
      filename: "/app/src/order.js",
      lineno: 42,
      colno: 15,
    });
    expect(row.fingerprint).toEqual(["TypeError", "processOrder"]);
  });

  it("keeps SDK-provided structured frames instead of reparsing", () => {
    const input: ExportLogsServiceRequest = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1000000000",
                  attributes: [
                    {
                      key: "exception.type",
                      value: { stringValue: "TypeError" },
                    },
                    {
                      key: "exception.message",
                      value: { stringValue: "x is null" },
                    },
                    {
                      key: "exception.stacktrace",
                      value: {
                        stringValue:
                          "TypeError: x is null\n    at processOrder (/app/src/order.js:42:15)",
                      },
                    },
                    {
                      key: "exception.structured_frames",
                      value: {
                        stringValue: JSON.stringify([
                          {
                            filename: "src/sdk.js",
                            function: "sdkFrame",
                            in_app: true,
                          },
                        ]),
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const ndjson = extractErrorsFromLogs(input, "acme");
    const row = JSON.parse(ndjson.trim());

    expect(JSON.parse(row.exception_frames)).toEqual([
      {
        filename: "src/sdk.js",
        function: "sdkFrame",
        in_app: true,
      },
    ]);
    expect(row.fingerprint).toEqual(["TypeError", "sdkFrame"]);
  });

  it("defaults mechanism_handled to true when not specified", () => {
    const input: ExportLogsServiceRequest = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1000000000",
                  attributes: [
                    {
                      key: "exception.type",
                      value: { stringValue: "Error" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const ndjson = extractErrorsFromLogs(input, "acme");
    const row = JSON.parse(ndjson.trim());
    expect(row.mechanism_handled).toBe(true);
    expect(row.mechanism_type).toBe("generic");
  });
});

describe("extractErrorsFromTraces", () => {
  it("returns empty string when no exception events", () => {
    const input: ExportTraceServiceRequest = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "t1",
                  spanId: "s1",
                  name: "GET /users",
                  startTimeUnixNano: "1000000000",
                  endTimeUnixNano: "2000000000",
                  events: [
                    {
                      timeUnixNano: "1500000000",
                      name: "cache.hit",
                      attributes: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(extractErrorsFromTraces(input, "acme")).toBe("");
  });

  it("returns empty string for empty request", () => {
    expect(extractErrorsFromTraces({}, "acme")).toBe("");
    expect(extractErrorsFromTraces({ resourceSpans: [] }, "acme")).toBe("");
  });

  it("extracts error from span exception event", () => {
    const input: ExportTraceServiceRequest = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "order-svc" } },
              { key: "service.version", value: { stringValue: "2.0.0" } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "trace-123",
                  spanId: "span-456",
                  name: "processOrder",
                  startTimeUnixNano: "1544712660000000000",
                  endTimeUnixNano: "1544712661000000000",
                  status: { code: 2, message: "error" },
                  events: [
                    {
                      timeUnixNano: "1544712660500000000",
                      name: "exception",
                      attributes: [
                        {
                          key: "exception.type",
                          value: { stringValue: "ValueError" },
                        },
                        {
                          key: "exception.message",
                          value: { stringValue: "Invalid order ID" },
                        },
                        {
                          key: "exception.stacktrace",
                          value: {
                            stringValue: "ValueError: Invalid order ID\n  at processOrder (order.js:10)",
                          },
                        },
                      ],
                    },
                    {
                      timeUnixNano: "1544712660600000000",
                      name: "log",
                      attributes: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const ndjson = extractErrorsFromTraces(input, "acme");
    const lines = ndjson.trim().split("\n");
    expect(lines).toHaveLength(1);

    const row = JSON.parse(lines[0]!);
    expect(row.project_id).toBe("acme");
    expect(row.service_name).toBe("order-svc");
    expect(row.exception_type).toBe("ValueError");
    expect(row.exception_message).toBe("Invalid order ID");
    expect(row.trace_id).toBe("trace-123");
    expect(row.span_id).toBe("span-456");
    expect(row.source_signal).toBe("trace");
    expect(row.release).toBe("2.0.0");
    expect(row.fingerprint_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("extracts multiple exceptions from multiple spans", () => {
    const input: ExportTraceServiceRequest = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "api" } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "t1",
                  spanId: "s1",
                  name: "span1",
                  startTimeUnixNano: "1000000000",
                  endTimeUnixNano: "2000000000",
                  events: [
                    {
                      timeUnixNano: "1500000000",
                      name: "exception",
                      attributes: [
                        {
                          key: "exception.type",
                          value: { stringValue: "Error1" },
                        },
                        {
                          key: "exception.message",
                          value: { stringValue: "first" },
                        },
                      ],
                    },
                  ],
                },
                {
                  traceId: "t1",
                  spanId: "s2",
                  name: "span2",
                  startTimeUnixNano: "2000000000",
                  endTimeUnixNano: "3000000000",
                  events: [
                    {
                      timeUnixNano: "2500000000",
                      name: "exception",
                      attributes: [
                        {
                          key: "exception.type",
                          value: { stringValue: "Error2" },
                        },
                        {
                          key: "exception.message",
                          value: { stringValue: "second" },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const ndjson = extractErrorsFromTraces(input, "acme");
    const lines = ndjson.trim().split("\n");
    expect(lines).toHaveLength(2);

    const row1 = JSON.parse(lines[0]!);
    const row2 = JSON.parse(lines[1]!);
    expect(row1.exception_type).toBe("Error1");
    expect(row2.exception_type).toBe("Error2");
    expect(row1.span_id).toBe("s1");
    expect(row2.span_id).toBe("s2");
  });
});
