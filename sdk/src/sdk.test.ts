import { describe, it, expect, beforeEach } from "vitest";
import { ROOT_CONTEXT, trace, propagation } from "@opentelemetry/api";
import {
  normalizeError,
  shouldIgnoreError,
  errorToAttributes,
  applyBeforeSend,
  resolveMetricReaderOptions,
  setUser,
  setTags,
  resetContext,
  DEFAULT_IGNORE_ERRORS,
  DEFAULT_DENY_URLS,
  ATTR,
  createStradaBaggage,
  BAGGAGE_SESSION_ID,
  BAGGAGE_USER_ID,
} from "./shared.ts";
import { getBrowserWorkContext } from "./browser.ts";

beforeEach(() => {
  resetContext();
});

// ---------------------------------------------------------------------------
// normalizeError
// ---------------------------------------------------------------------------

describe("normalizeError", () => {
  it("returns the same Error if already an Error", () => {
    const err = new TypeError("boom");
    expect(normalizeError(err)).toBe(err);
  });

  it("wraps a string into an Error", () => {
    const err = normalizeError("something broke");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("something broke");
  });

  it("wraps a number into an Error", () => {
    const err = normalizeError(42);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("42");
  });

  it("wraps null into an Error", () => {
    const err = normalizeError(null);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("null");
  });

  it("wraps undefined into an Error", () => {
    const err = normalizeError(undefined);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("undefined");
  });

  it("wraps an object with message property", () => {
    const err = normalizeError({ message: "obj error", code: 500 });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("obj error");
  });

  it("wraps an object without message via JSON.stringify", () => {
    const err = normalizeError({ code: 500 });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('{"code":500}');
  });
});

// ---------------------------------------------------------------------------
// shouldIgnoreError
// ---------------------------------------------------------------------------

describe("shouldIgnoreError", () => {
  it("ignores 'Script error.' by default", () => {
    const err = new Error("Script error.");
    expect(shouldIgnoreError(err, {})).toBe(true);
  });

  it("ignores 'Script error' without trailing dot", () => {
    const err = new Error("Script error");
    expect(shouldIgnoreError(err, {})).toBe(true);
  });

  it("ignores ResizeObserver loop limit exceeded", () => {
    const err = new Error("ResizeObserver loop limit exceeded");
    expect(shouldIgnoreError(err, {})).toBe(true);
  });

  it("ignores ResizeObserver loop completed", () => {
    const err = new Error(
      "ResizeObserver loop completed with undelivered notifications",
    );
    expect(shouldIgnoreError(err, {})).toBe(true);
  });

  it("ignores errors with chrome-extension in stack", () => {
    const err = new Error("something");
    err.stack =
      "Error: something\n    at chrome-extension://abc123/content.js:1:1";
    expect(shouldIgnoreError(err, {})).toBe(true);
  });

  it("ignores errors with moz-extension in stack", () => {
    const err = new Error("something");
    err.stack =
      "Error: something\n    at moz-extension://abc123/content.js:1:1";
    expect(shouldIgnoreError(err, {})).toBe(true);
  });

  it("does not ignore normal errors", () => {
    const err = new Error("TypeError: Cannot read property 'foo' of null");
    expect(shouldIgnoreError(err, {})).toBe(false);
  });

  it("respects user-supplied ignoreErrors patterns", () => {
    const err = new Error("my custom noise");
    expect(
      shouldIgnoreError(err, { ignoreErrors: [/my custom noise/] }),
    ).toBe(true);
  });

  it("respects user-supplied ignoreErrors strings", () => {
    const err = new Error("network timeout occurred");
    expect(
      shouldIgnoreError(err, { ignoreErrors: ["network timeout"] }),
    ).toBe(true);
  });

  it("respects user-supplied denyUrls", () => {
    const err = new Error("something");
    err.stack = "Error: something\n    at https://ads.example.com/tracker.js:1:1";
    expect(
      shouldIgnoreError(err, {
        denyUrls: [/https:\/\/ads\.example\.com/],
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_IGNORE_ERRORS & DEFAULT_DENY_URLS
// ---------------------------------------------------------------------------

describe("default patterns", () => {
  it("has reasonable default ignore error count", () => {
    expect(DEFAULT_IGNORE_ERRORS.length).toBeGreaterThanOrEqual(5);
  });

  it("has extension URL deny patterns", () => {
    expect(DEFAULT_DENY_URLS.length).toBeGreaterThanOrEqual(3);
    const urls = DEFAULT_DENY_URLS.map((r) => r.source);
    expect(urls.some((u) => u.includes("chrome-extension"))).toBe(true);
    expect(urls.some((u) => u.includes("moz-extension"))).toBe(true);
    expect(urls.some((u) => u.includes("safari-extension"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// errorToAttributes
// ---------------------------------------------------------------------------

describe("errorToAttributes", () => {
  it("produces correct exception.* attributes", () => {
    const err = new TypeError("boom");
    const attrs = errorToAttributes(err);

    expect(attrs[ATTR.EXCEPTION_TYPE]).toBe("TypeError");
    expect(attrs[ATTR.EXCEPTION_MESSAGE]).toBe("boom");
    expect(attrs[ATTR.EXCEPTION_STACKTRACE]).toBeTruthy();
    expect(attrs[ATTR.EXCEPTION_MECHANISM_TYPE]).toBe("generic");
    expect(attrs[ATTR.EXCEPTION_MECHANISM_HANDLED]).toBe("true");
  });

  it("marks unhandled errors correctly", () => {
    const err = new Error("crash");
    const attrs = errorToAttributes(err, {
      handled: false,
      mechanism: "onerror",
    });

    expect(attrs[ATTR.EXCEPTION_MECHANISM_TYPE]).toBe("onerror");
    expect(attrs[ATTR.EXCEPTION_MECHANISM_HANDLED]).toBe("false");
  });

  it("uses generic as the default mechanism type", () => {
    const err = new Error("crash");
    const attrs = errorToAttributes(err, { handled: false });

    expect(attrs[ATTR.EXCEPTION_MECHANISM_TYPE]).toBe("generic");
    expect(attrs[ATTR.EXCEPTION_MECHANISM_HANDLED]).toBe("false");
  });

  it("extracts fingerprint from options", () => {
    const err = new Error("timeout");
    const attrs = errorToAttributes(err, {
      fingerprint: ["db-timeout", "users-service"],
    });

    expect(attrs[ATTR.EXCEPTION_FINGERPRINT]).toBe(
      '["db-timeout","users-service"]',
    );
  });

  it("extracts fingerprint from error.fingerprint property", () => {
    const err = Object.assign(new Error("checkout failed"), {
      fingerprint: ["checkout-failed", "processOrder"],
    });
    const attrs = errorToAttributes(err);

    expect(attrs[ATTR.EXCEPTION_FINGERPRINT]).toBe(
      '["checkout-failed","processOrder"]',
    );
  });

  it("prefers options fingerprint over error.fingerprint", () => {
    const err = Object.assign(new Error("fail"), {
      fingerprint: ["from-error"],
    });
    const attrs = errorToAttributes(err, {
      fingerprint: ["from-options"],
    });

    expect(attrs[ATTR.EXCEPTION_FINGERPRINT]).toBe('["from-options"]');
  });

  it("merges tags from options", () => {
    const err = new Error("fail");
    const attrs = errorToAttributes(err, {
      tags: { route: "/checkout", userId: "123" },
    });

    expect(attrs["route"]).toBe("/checkout");
    expect(attrs["userId"]).toBe("123");
  });

  it("merges global tags set via setTags()", () => {
    setTags({ release: "1.0.0" });
    const err = new Error("fail");
    const attrs = errorToAttributes(err, { tags: { route: "/api" } });

    expect(attrs["release"]).toBe("1.0.0");
    expect(attrs["route"]).toBe("/api");
  });

  it("per-event tags override global tags", () => {
    setTags({ env: "staging" });
    const err = new Error("fail");
    const attrs = errorToAttributes(err, {
      tags: { env: "production" },
    });

    expect(attrs["env"]).toBe("production");
  });

  it("includes user context set via setUser()", () => {
    setUser({ id: "user_42", email: "tommy@acme.com" });
    const err = new Error("fail");
    const attrs = errorToAttributes(err);

    expect(attrs[ATTR.USER_ID]).toBe("user_42");
    expect(attrs[ATTR.USER_EMAIL]).toBe("tommy@acme.com");
  });

  it("does not include user attributes when user is not set", () => {
    const err = new Error("fail");
    const attrs = errorToAttributes(err);

    expect(attrs[ATTR.USER_ID]).toBeUndefined();
    expect(attrs[ATTR.USER_EMAIL]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyBeforeSend
// ---------------------------------------------------------------------------

describe("applyBeforeSend", () => {
  it("returns the original error when hook is missing", () => {
    const err = new Error("boom");
    expect(applyBeforeSend(err, undefined)).toBe(err);
  });

  it("returns null when beforeSend drops the error", () => {
    const err = new Error("boom");
    expect(applyBeforeSend(err, () => null)).toBeNull();
  });

  it("returns the rewritten error when beforeSend modifies it", () => {
    const err = new Error("boom");
    const rewritten = new Error("rewritten");

    expect(applyBeforeSend(err, () => rewritten)).toBe(rewritten);
  });
});

// ---------------------------------------------------------------------------
// metric reader options
// ---------------------------------------------------------------------------

describe("resolveMetricReaderOptions", () => {
  it("uses the sdk default metrics export interval", () => {
    expect(
      resolveMetricReaderOptions({
        endpoint: "https://ingest.example.com",
        service: "frontend",
      }),
    ).toMatchInlineSnapshot(`
      {
        "exportIntervalMillis": 10000,
      }
    `);
  });

  it("lets telemetry.metrics override the default interval", () => {
    expect(
      resolveMetricReaderOptions({
        endpoint: "https://ingest.example.com",
        service: "frontend",
        telemetry: {
          metrics: {
            exportIntervalMillis: 2500,
            exportTimeoutMillis: 1500,
          },
        },
      }),
    ).toMatchInlineSnapshot(`
      {
        "exportIntervalMillis": 2500,
        "exportTimeoutMillis": 1500,
      }
    `);
  });
});

// ---------------------------------------------------------------------------
// browser trace context
// ---------------------------------------------------------------------------

describe("getBrowserWorkContext", () => {
  it("injects the pageview span when no active span exists", () => {
    const pageviewSpan = trace.wrapSpanContext({
      traceId: "11111111111111111111111111111111",
      spanId: "1111111111111111",
      traceFlags: 1,
    });

    const ctx = getBrowserWorkContext(ROOT_CONTEXT, pageviewSpan);

    expect(trace.getSpan(ctx)?.spanContext()).toMatchInlineSnapshot(`
      {
        "spanId": "1111111111111111",
        "traceFlags": 1,
        "traceId": "11111111111111111111111111111111",
      }
    `);
  });

  it("preserves an existing active span instead of overwriting it", () => {
    const activeSpan = trace.wrapSpanContext({
      traceId: "22222222222222222222222222222222",
      spanId: "2222222222222222",
      traceFlags: 1,
    });
    const pageviewSpan = trace.wrapSpanContext({
      traceId: "33333333333333333333333333333333",
      spanId: "3333333333333333",
      traceFlags: 1,
    });

    const activeContext = trace.setSpan(ROOT_CONTEXT, activeSpan);
    const ctx = getBrowserWorkContext(activeContext, pageviewSpan);

    expect(trace.getSpan(ctx)?.spanContext()).toMatchInlineSnapshot(`
      {
        "spanId": "2222222222222222",
        "traceFlags": 1,
        "traceId": "22222222222222222222222222222222",
      }
    `);
  });
});

// ---------------------------------------------------------------------------
// createStradaBaggage
// ---------------------------------------------------------------------------

describe("createStradaBaggage", () => {
  it("creates baggage with session.id", () => {
    const baggage = createStradaBaggage("sess-123");
    expect(baggage.getEntry(BAGGAGE_SESSION_ID)?.value).toBe("sess-123");
    expect(baggage.getEntry(BAGGAGE_USER_ID)).toBeUndefined();
  });

  it("creates baggage with session.id and user.id", () => {
    const baggage = createStradaBaggage("sess-456", "user_42");
    expect(baggage.getEntry(BAGGAGE_SESSION_ID)?.value).toBe("sess-456");
    expect(baggage.getEntry(BAGGAGE_USER_ID)?.value).toBe("user_42");
  });

  it("omits user.id when undefined", () => {
    const baggage = createStradaBaggage("sess-789", undefined);
    expect(baggage.getEntry(BAGGAGE_SESSION_ID)?.value).toBe("sess-789");
    expect(baggage.getEntry(BAGGAGE_USER_ID)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// baggage round-trip: inject → extract → read
// ---------------------------------------------------------------------------

describe("baggage round-trip propagation", () => {
  it("serializes and deserializes session.id and user.id through headers", () => {
    const { W3CBaggagePropagator } = require("@opentelemetry/core");
    const prop = new W3CBaggagePropagator();

    // Simulate browser side: create baggage and inject into headers
    const baggage = createStradaBaggage("browser-session-abc", "user_123");
    const ctxWithBaggage = propagation.setBaggage(ROOT_CONTEXT, baggage);
    const headers: Record<string, string> = {};
    prop.inject(ctxWithBaggage, headers, {
      set(carrier: Record<string, string>, key: string, value: string) {
        carrier[key] = value;
      },
    });

    // Verify baggage header was set
    expect(headers["baggage"]).toBeTruthy();
    expect(headers["baggage"]).toContain("strada.session.id=browser-session-abc");
    expect(headers["baggage"]).toContain("strada.user.id=user_123");

    // Simulate server side: extract baggage from headers
    const serverCtx = prop.extract(ROOT_CONTEXT, headers, {
      get(carrier: Record<string, string>, key: string) {
        return carrier[key];
      },
      keys(carrier: Record<string, string>) {
        return Object.keys(carrier);
      },
    });

    // Read baggage on server
    const serverBaggage = propagation.getBaggage(serverCtx);
    expect(serverBaggage).toBeTruthy();
    expect(serverBaggage!.getEntry(BAGGAGE_SESSION_ID)?.value).toBe("browser-session-abc");
    expect(serverBaggage!.getEntry(BAGGAGE_USER_ID)?.value).toBe("user_123");
  });

  it("works without user.id (anonymous session)", () => {
    const { W3CBaggagePropagator } = require("@opentelemetry/core");
    const prop = new W3CBaggagePropagator();

    const baggage = createStradaBaggage("anon-session-xyz");
    const ctxWithBaggage = propagation.setBaggage(ROOT_CONTEXT, baggage);
    const headers: Record<string, string> = {};
    prop.inject(ctxWithBaggage, headers, {
      set(carrier: Record<string, string>, key: string, value: string) {
        carrier[key] = value;
      },
    });

    expect(headers["baggage"]).toContain("strada.session.id=anon-session-xyz");
    expect(headers["baggage"]).not.toContain("strada.user.id");

    const serverCtx = prop.extract(ROOT_CONTEXT, headers, {
      get(carrier: Record<string, string>, key: string) {
        return carrier[key];
      },
      keys(carrier: Record<string, string>) {
        return Object.keys(carrier);
      },
    });

    const serverBaggage = propagation.getBaggage(serverCtx);
    expect(serverBaggage!.getEntry(BAGGAGE_SESSION_ID)?.value).toBe("anon-session-xyz");
    expect(serverBaggage!.getEntry(BAGGAGE_USER_ID)).toBeUndefined();
  });
});
