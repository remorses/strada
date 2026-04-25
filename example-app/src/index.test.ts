// Integration test suite that exercises the example Spiceflow app and emits
// real OTel telemetry to the Strada collector. Each test hits a route via
// app.handle(), which triggers traces, logs, metrics, and errors that flow
// through the full pipeline: SDK → collector → Tinybird/ClickHouse.
//
// Run with:
//   STRADA_PROJECT_ID=<id> STRADA_ENDPOINT=<url> pnpm vitest run
//
// After running, use `strada issues list -p <slug>` to verify the data landed.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Spiceflow } from "spiceflow";
import {
  captureException,
  flush,
  initStrada,
  logs,
  metrics,
  shutdown,
  SeverityNumber,
  SpanStatusCode,
  trace,
} from "@strada.sh/sdk";

const projectId = process.env.STRADA_PROJECT_ID;
const endpoint = process.env.STRADA_ENDPOINT;

describe.skipIf(!projectId || !endpoint)("example-app telemetry", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeAll(() => {
    initStrada({
      projectId: projectId!,
      endpoint: endpoint!,
      service: "example-app-test",
      version: "0.0.1-test",
      environment: "test",

      telemetry: {
        metrics: { exportIntervalMillis: 500, exportTimeoutMillis: 5_000 },
      },
    });

    const tracer = trace.getTracer("example-app-test");
    const logger = logs.getLogger("example-app-test");
    const meter = metrics.getMeter("example-app-test");
    const requestCounter = meter.createCounter("test.requests");

    app = new Spiceflow({ tracer })
      // ── Healthy route ──
      .get("/healthy", () => {
        requestCounter.add(1, { route: "/healthy" });
        logger.emit({
          severityNumber: SeverityNumber.INFO,
          severityText: "INFO",
          body: "health check passed",
        });
        return { ok: true };
      })

      // ── TypeError: property access on null ──
      .get("/error/type-error", ({ span }) => {
        try {
          const obj: any = null;
          obj.foo.bar;
        } catch (error) {
          captureException(error, {
            mechanism: "generic",
            handled: true,
            tags: { route: "/error/type-error", severity: "high" },
          });
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        return { error: "TypeError" };
      })

      // ── ReferenceError: undefined variable ──
      .get("/error/reference-error", ({ span }) => {
        try {
          // @ts-expect-error intentional
          const x = undefinedVariable;
        } catch (error) {
          captureException(error, {
            mechanism: "generic",
            handled: true,
            tags: { route: "/error/reference-error" },
          });
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        return { error: "ReferenceError" };
      })

      // ── Custom error with fingerprint override ──
      .get("/error/database-timeout", ({ span }) => {
        const err = new Error("Connection timed out after 30000ms");
        err.name = "DatabaseTimeoutError";
        captureException(err, {
          mechanism: "generic",
          handled: true,
          fingerprint: ["database-timeout", "users-service"],
          tags: {
            "db.system": "postgresql",
            "db.name": "users",
            route: "/error/database-timeout",
          },
        });
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: "database timeout",
        });
        return { error: "DatabaseTimeoutError" };
      })

      // ── Unhandled error (mechanism.handled = false) ──
      .get("/error/unhandled", ({ span }) => {
        const err = new Error("Unexpected null pointer in payment processor");
        err.name = "PaymentProcessorError";
        captureException(err, {
          mechanism: "uncaughtException",
          handled: false,
          tags: {
            route: "/error/unhandled",
            "payment.provider": "stripe",
          },
        });
        span.setStatus({ code: SpanStatusCode.ERROR });
        return { error: "unhandled" };
      })

      // ── Validation error with dynamic values (tests fingerprint stripping) ──
      .get("/error/validation", ({ span }) => {
        const userId = Math.floor(Math.random() * 100000);
        const err = new Error(
          `Validation failed for user ${userId}: email "user${userId}@test.com" is invalid`,
        );
        err.name = "ValidationError";
        captureException(err, {
          mechanism: "generic",
          handled: true,
          tags: { route: "/error/validation" },
        });
        span.setStatus({ code: SpanStatusCode.ERROR });
        return { error: "ValidationError" };
      })

      // ── Error recorded as span exception event (trace-sourced) ──
      .get("/error/span-exception", ({ span }) => {
        const err = new Error("Redis connection refused on port 6379");
        err.name = "RedisConnectionError";
        span.recordException(err);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: "redis connection refused",
        });
        return { error: "span-exception" };
      })

      // ── Multiple errors in one request ──
      .get("/error/multiple", ({ span }) => {
        const err1 = new Error("First: config file not found");
        err1.name = "ConfigError";
        captureException(err1, {
          mechanism: "generic",
          handled: true,
          tags: { route: "/error/multiple", order: "first" },
        });

        const err2 = new Error("Second: fallback config also missing");
        err2.name = "ConfigError";
        captureException(err2, {
          mechanism: "generic",
          handled: true,
          tags: { route: "/error/multiple", order: "second" },
        });

        span.setStatus({ code: SpanStatusCode.ERROR });
        return { error: "multiple" };
      })

      // ── Custom event (not an error, tests track-like log records) ──
      .get("/event/purchase", ({ span }) => {
        logger.emit({
          severityNumber: SeverityNumber.INFO,
          severityText: "INFO",
          body: "purchase_completed",
          attributes: {
            "event.name": "purchase_completed",
            "custom.plan": "pro",
            "custom.amount": "49.99",
            "custom.currency": "USD",
          },
        });
        return { event: "purchase_completed" };
      });
  });

  afterAll(async () => {
    await flush();
    // Give the SDK time to export all batched telemetry
    await new Promise((r) => setTimeout(r, 3000));
    await shutdown();
  });

  test("healthy route returns ok and emits trace + log", async () => {
    const res = await app.handle(new Request("http://localhost/healthy"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true });
  });

  test("TypeError: property access on null", async () => {
    const res = await app.handle(new Request("http://localhost/error/type-error"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ error: "TypeError" });
  });

  test("ReferenceError: undefined variable", async () => {
    const res = await app.handle(new Request("http://localhost/error/reference-error"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ error: "ReferenceError" });
  });

  test("DatabaseTimeoutError with custom fingerprint", async () => {
    const res = await app.handle(new Request("http://localhost/error/database-timeout"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ error: "DatabaseTimeoutError" });
  });

  test("unhandled PaymentProcessorError", async () => {
    const res = await app.handle(new Request("http://localhost/error/unhandled"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ error: "unhandled" });
  });

  test("ValidationError with dynamic values in message", async () => {
    // Hit multiple times to test fingerprint grouping with stripped dynamic values
    for (let i = 0; i < 3; i++) {
      const res = await app.handle(new Request("http://localhost/error/validation"));
      expect(res.status).toBe(200);
    }
  });

  test("span exception event (trace-sourced error)", async () => {
    const res = await app.handle(new Request("http://localhost/error/span-exception"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ error: "span-exception" });
  });

  test("multiple errors in one request", async () => {
    const res = await app.handle(new Request("http://localhost/error/multiple"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ error: "multiple" });
  });

  test("custom purchase event", async () => {
    const res = await app.handle(new Request("http://localhost/event/purchase"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ event: "purchase_completed" });
  });

  test("flush sends all buffered telemetry", async () => {
    await flush();
  });
});
