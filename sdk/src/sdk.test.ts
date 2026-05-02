import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ROOT_CONTEXT, trace, propagation } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  normalizeError,
  shouldIgnoreError,
  errorToAttributes,
  recordExceptionOnSpan,
  normalizeLogInput,
  applyBeforeSend,
  resolveMetricReaderOptions,
  resolveReleaseAttributes,
  resolveUserId,
  readCookie,
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
import {
  MAX_LOG_STRING_LENGTH,
  formatLogValue as formatJsonLogValue,
} from "./log-format-json.ts";

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

    expect(attrs[ATTR["exception.type"]]).toBe("TypeError");
    expect(attrs[ATTR["exception.message"]]).toBe("boom");
    expect(attrs[ATTR["exception.stacktrace"]]).toBeTruthy();
    expect(attrs[ATTR["exception.mechanism.type"]]).toBe("generic");
    expect(attrs[ATTR["exception.mechanism.handled"]]).toBe("true");
  });

  it("marks unhandled errors correctly", () => {
    const err = new Error("crash");
    const attrs = errorToAttributes(err, {
      handled: false,
      mechanism: "onerror",
    });

    expect(attrs[ATTR["exception.mechanism.type"]]).toBe("onerror");
    expect(attrs[ATTR["exception.mechanism.handled"]]).toBe("false");
  });

  it("uses generic as the default mechanism type", () => {
    const err = new Error("crash");
    const attrs = errorToAttributes(err, { handled: false });

    expect(attrs[ATTR["exception.mechanism.type"]]).toBe("generic");
    expect(attrs[ATTR["exception.mechanism.handled"]]).toBe("false");
  });

  it("extracts fingerprint from options", () => {
    const err = new Error("timeout");
    const attrs = errorToAttributes(err, {
      fingerprint: ["db-timeout", "users-service"],
    });

    expect(attrs[ATTR["exception.fingerprint"]]).toBe(
      '["db-timeout","users-service"]',
    );
  });

  it("extracts fingerprint from error.fingerprint property", () => {
    const err = Object.assign(new Error("checkout failed"), {
      fingerprint: ["checkout-failed", "processOrder"],
    });
    const attrs = errorToAttributes(err);

    expect(attrs[ATTR["exception.fingerprint"]]).toBe(
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

    expect(attrs[ATTR["exception.fingerprint"]]).toBe('["from-options"]');
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

  it("does not include user attributes by default", () => {
    const err = new Error("fail");
    const attrs = errorToAttributes(err);

    expect(attrs[ATTR["user.id"]]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// recordExceptionOnSpan
// ---------------------------------------------------------------------------

describe("recordExceptionOnSpan", () => {
  it("records the exception event and marks the span as errored", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const span = provider.getTracer("strada-test").startSpan("checkout");
    const err = new TypeError("payment failed");

    recordExceptionOnSpan(err, span);
    span.end();
    await provider.forceFlush();

    const finished = exporter.getFinishedSpans()[0]!;
    expect(finished.status).toMatchInlineSnapshot(`
      {
        "code": 2,
        "message": "payment failed",
      }
    `);
    expect(finished.events).toHaveLength(1);
    const event = finished.events[0];
    if (!event) throw new Error("missing exception event");
    const attrs = event.attributes;
    if (!attrs) throw new Error("missing exception attributes");
    expect(event.name).toBe("exception");
    expect(attrs[ATTR["exception.type"]]).toBe("TypeError");
    expect(attrs[ATTR["exception.message"]]).toBe("payment failed");
    expect(String(attrs[ATTR["exception.stacktrace"]])).toContain(
      "TypeError: payment failed",
    );
  });

  it("does nothing when there is no span", () => {
    expect(() => recordExceptionOnSpan(new Error("boom"), undefined)).not.toThrow();
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
        projectId: "test",
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
        projectId: "test",
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
// release metadata
// ---------------------------------------------------------------------------

describe("resolveReleaseAttributes", () => {
  it("prefers explicit options over platform env vars", () => {
    expect(
      resolveReleaseAttributes(
        {
          projectId: "test",
          service: "frontend",
          version: "frontend@1.2.3",
          releaseCommit: "option-commit",
          releaseBranch: "option-branch",
          deploymentId: "option-deploy",
        },
        {
          VERCEL_GIT_COMMIT_SHA: "env-commit",
          VERCEL_GIT_COMMIT_REF: "env-branch",
          VERCEL_DEPLOYMENT_ID: "env-deploy",
        },
      ),
    ).toMatchInlineSnapshot(`
      {
        "deployment.id": "option-deploy",
        "service.version": "frontend@1.2.3",
        "vcs.ref.head.name": "option-branch",
        "vcs.ref.head.revision": "option-commit",
      }
    `);
  });

  it("uses platform env vars when options are absent", () => {
    expect(
      resolveReleaseAttributes(
        {
          projectId: "test",
          service: "frontend",
        },
        {
          RENDER_GIT_COMMIT: "render-commit",
          RENDER_GIT_BRANCH: "main",
          RENDER_INSTANCE_ID: "srv-instance",
        },
      ),
    ).toMatchInlineSnapshot(`
      {
        "deployment.id": "srv-instance",
        "vcs.ref.head.name": "main",
        "vcs.ref.head.revision": "render-commit",
      }
    `);
  });

  it("uses commit as deployment id when platform deployment id is absent", () => {
    expect(
      resolveReleaseAttributes(
        {
          projectId: "test",
          service: "frontend",
        },
        {
          CF_PAGES_COMMIT_SHA: "cf-pages-commit",
          CF_PAGES_BRANCH: "main",
        },
      ),
    ).toMatchInlineSnapshot(`
      {
        "deployment.id": "cf-pages-commit",
        "vcs.ref.head.name": "main",
        "vcs.ref.head.revision": "cf-pages-commit",
      }
    `);
  });

  it("uses GitHub Actions pull request branch and run id", () => {
    expect(
      resolveReleaseAttributes(
        {
          projectId: "test",
          service: "frontend",
        },
        {
          GITHUB_SHA: "github-merge-commit",
          GITHUB_HEAD_REF: "feature-branch",
          GITHUB_REF_NAME: "123/merge",
          GITHUB_RUN_ID: "1658821493",
        },
      ),
    ).toMatchInlineSnapshot(`
      {
        "deployment.id": "1658821493",
        "vcs.ref.head.name": "feature-branch",
        "vcs.ref.head.revision": "github-merge-commit",
      }
    `);
  });
});

// ---------------------------------------------------------------------------
// console-style log normalization
// ---------------------------------------------------------------------------

describe("normalizeLogInput", () => {
  it("formats a single string as console-style body without attributes", () => {
    expect(normalizeLogInput(["checkout started"])).toMatchInlineSnapshot(`
      {
        "attributes": {},
        "body": "checkout started",
      }
    `);
  });

  it("formats multiple args like console output without structured attributes", () => {
    expect(normalizeLogInput(["user loaded", { id: "user_123" }, true])).toMatchInlineSnapshot(`
      {
        "attributes": {},
        "body": "user loaded { id: 'user_123' } true",
      }
    `);
  });

  it("treats one plain object as a structured log", () => {
    expect(
      normalizeLogInput([
        {
          message: "checkout started",
          checkoutId: "chk_123",
          paid: true,
          attempt: 2,
        },
      ]),
    ).toMatchInlineSnapshot(`
      {
        "attributes": {
          "attempt": 2,
          "checkoutId": "chk_123",
          "message": "checkout started",
          "paid": true,
        },
        "body": "checkout started",
      }
    `);
  });

  it("uses JSON body when a structured log has no string message", () => {
    expect(normalizeLogInput([{ event: "cache_hit", key: "user:123" }])).toMatchInlineSnapshot(`
      {
        "attributes": {
          "event": "cache_hit",
          "key": "user:123",
        },
        "body": "{\"event\":\"cache_hit\",\"key\":\"user:123\"}",
      }
    `);
  });

  it("drops nullish attributes and stringifies nested structured values", () => {
    expect(
      normalizeLogInput([
        {
          message: "payload received",
          payload: { ok: true },
          list: [1, 2],
          missing: undefined,
          nil: null,
        },
      ]),
    ).toMatchInlineSnapshot(`
      {
        "attributes": {
          "list": "[1,2]",
          "message": "payload received",
          "payload": "{\"ok\":true}",
        },
        "body": "payload received",
      }
    `);
  });

  it("formats errors as console body text without exception attributes", () => {
    const error = new Error("payment failed");
    error.stack = "Error: payment failed\n    at checkout.ts:1:1";

    expect(normalizeLogInput(["failed", error])).toMatchInlineSnapshot(`
      {
        "attributes": {},
        "body": "failed Error: payment failed
          at checkout.ts:1:1",
      }
    `);
  });

  it("truncates long structured string attributes and keeps object shape in the body", () => {
    const long = "a".repeat(MAX_LOG_STRING_LENGTH + 3);

    const normalized = normalizeLogInput([
      {
        message: "large payload",
        nested: {
          token: long,
          ok: true,
        },
        topLevel: long,
      },
    ]);

    expect(normalized.attributes.nested).toContain('{"token":"');
    expect(normalized.attributes.nested).toContain("… [truncated 3 chars]");
    expect(normalized.attributes.nested).toContain('"ok":true');
    expect(String(normalized.attributes.topLevel).length).toBeGreaterThan(MAX_LOG_STRING_LENGTH);
    expect(normalized.attributes.topLevel).toMatch(/… \[truncated 3 chars\]$/);
  });
});

describe("formatJsonLogValue", () => {
  it("uses JSON-style formatting for browser and Workers", () => {
    expect(formatJsonLogValue({ id: "user_123" })).toMatchInlineSnapshot(`"{\"id\":\"user_123\"}"`);
    expect(formatJsonLogValue([1, 2])).toMatchInlineSnapshot(`"[1,2]"`);
  });

  it("truncates nested strings while preserving JSON object shape", () => {
    const long = "b".repeat(MAX_LOG_STRING_LENGTH + 2);
    const formatted = formatJsonLogValue({ nested: { token: long }, ok: true });

    expect(formatted).toContain('{"nested":{"token":"');
    expect(formatted).toContain('"ok":true}');
    expect(formatted).toMatch(/… \[truncated 2 chars\]/);
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
// readCookie + resolveUserId (cookie-based user ID)
// ---------------------------------------------------------------------------
// These tests simulate document.cookie in a Node environment by creating
// a minimal document object on globalThis.

describe("readCookie", () => {
  let cookieValue = "";
  const originalDocument = globalThis.document;
  const hadDocument = originalDocument !== undefined;

  beforeEach(() => {
    cookieValue = "";
    // Create a minimal document with a cookie getter
    (globalThis as any).document = {
      get cookie() { return cookieValue; },
    };
  });

  afterEach(() => {
    if (hadDocument) {
      (globalThis as any).document = originalDocument;
    } else {
      delete (globalThis as any).document;
    }
  });

  it("reads a cookie by name", () => {
    cookieValue = "strada_uid=user_42; other=value";
    expect(readCookie("strada_uid")).toBe("user_42");
  });

  it("returns undefined when cookie is not present", () => {
    cookieValue = "other=value";
    expect(readCookie("strada_uid")).toBeUndefined();
  });

  it("handles URL-encoded cookie values", () => {
    cookieValue = "strada_uid=user%20123";
    expect(readCookie("strada_uid")).toBe("user 123");
  });

  it("reads the first cookie when it appears first", () => {
    cookieValue = "strada_uid=first; another=second";
    expect(readCookie("strada_uid")).toBe("first");
  });

  it("reads cookie when it appears after other cookies", () => {
    cookieValue = "foo=bar; strada_uid=user_99; baz=qux";
    expect(readCookie("strada_uid")).toBe("user_99");
  });

  it("returns undefined when document.cookie is empty", () => {
    cookieValue = "";
    expect(readCookie("strada_uid")).toBeUndefined();
  });

  it("returns undefined when document is not defined", () => {
    if (hadDocument) {
      (globalThis as any).document = originalDocument;
    } else {
      delete (globalThis as any).document;
    }
    expect(readCookie("strada_uid")).toBeUndefined();
  });
});

describe("resolveUserId", () => {
  let cookieValue = "";
  const originalDocument = globalThis.document;
  const hadDocument = originalDocument !== undefined;

  beforeEach(() => {
    cookieValue = "";
    (globalThis as any).document = {
      get cookie() { return cookieValue; },
    };
  });

  afterEach(() => {
    if (hadDocument) {
      (globalThis as any).document = originalDocument;
    } else {
      delete (globalThis as any).document;
    }
  });

  it("returns undefined when nothing is set", () => {
    expect(resolveUserId({ projectId: "test", service: "s" })).toBeUndefined();
  });

  it("reads from cookie by default (strada_uid)", () => {
    cookieValue = "strada_uid=cookie_user";
    expect(resolveUserId({ projectId: "test", service: "s" })).toBe("cookie_user");
  });

  it("reads from custom cookie name", () => {
    cookieValue = "my_uid=custom_user";
    expect(resolveUserId({ projectId: "test", service: "s", userIdCookie: "my_uid" })).toBe("custom_user");
  });

  it("disables cookie reading with userIdCookie: false", () => {
    cookieValue = "strada_uid=cookie_user";
    expect(resolveUserId({ projectId: "test", service: "s", userIdCookie: false })).toBeUndefined();
  });

  it("explicit userId option takes priority over cookie", () => {
    cookieValue = "strada_uid=cookie_user";
    expect(resolveUserId({ projectId: "test", service: "s", userId: "explicit_user" })).toBe("explicit_user");
  });

  it("userId function takes priority over cookie", () => {
    cookieValue = "strada_uid=cookie_user";
    expect(resolveUserId({ projectId: "test", service: "s", userId: () => "fn_user" })).toBe("fn_user");
  });

  it("does not fall back when userId function returns empty string", () => {
    cookieValue = "strada_uid=cookie_user";
    expect(resolveUserId({ projectId: "test", service: "s", userId: () => "" })).toBe("");
  });

  it("falls back from userId function to cookie when function returns undefined", () => {
    cookieValue = "strada_uid=cookie_user";
    expect(resolveUserId({ projectId: "test", service: "s", userId: () => undefined })).toBe("cookie_user");
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
    expect(headers["baggage"]).toContain("user.id=user_123");

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
    expect(headers["baggage"]).not.toContain("user.id");

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
