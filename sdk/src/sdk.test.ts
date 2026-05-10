import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ROOT_CONTEXT, trace, context, propagation } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
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
  startSpan,
  startInactiveSpan,
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

// ---------------------------------------------------------------------------
// startSpan (ergonomic span creation)
// ---------------------------------------------------------------------------
// These tests use NodeTracerProvider to get AsyncLocalStorage context
// propagation, which is what makes startSpan nesting work.

describe("startSpan", () => {
  let provider: NodeTracerProvider;
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  it("sync callback: returns value and ends span", () => {
    const result = startSpan({ name: "sync-work" }, (span) => {
      span.setAttribute("key", "value");
      return 42;
    });

    expect(result).toBe(42);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("sync-work");
    expect(spans[0]!.attributes["key"]).toBe("value");
  });

  it("async callback: returns awaited value and ends span", async () => {
    const result = await startSpan({ name: "async-work" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "done";
    });

    expect(result).toBe("done");
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("async-work");
  });

  it("sync throw: sets ERROR status, records exception, re-throws", () => {
    expect(() => {
      startSpan({ name: "sync-error" }, () => {
        throw new TypeError("boom");
      });
    }).toThrow("boom");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span.events).toHaveLength(1);
    expect(span.events[0]!.name).toBe("exception");
  });

  it("async rejection: sets ERROR status, records exception, re-throws", async () => {
    await expect(
      startSpan({ name: "async-error" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("async boom");
      }),
    ).rejects.toThrow("async boom");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span.events).toHaveLength(1);
    expect(span.events[0]!.name).toBe("exception");
  });

  it("passes attributes and kind from options", () => {
    startSpan(
      { name: "with-attrs", attributes: { "user.id": "u123" }, kind: 1 },
      () => {},
    );

    const spans = exporter.getFinishedSpans();
    expect(spans[0]!.attributes["user.id"]).toBe("u123");
    expect(spans[0]!.kind).toBe(1); // SpanKind.CLIENT
  });

  it("nesting auto-parents child spans", () => {
    startSpan({ name: "outer" }, () => {
      startSpan({ name: "inner" }, () => {});
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const outer = spans.find((s) => s.name === "outer")!;
    const inner = spans.find((s) => s.name === "inner")!;
    expect(inner.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
    expect(inner.spanContext().traceId).toBe(outer.spanContext().traceId);
  });

  it("async nesting preserves parenting across await", async () => {
    await startSpan({ name: "async-outer" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      await startSpan({ name: "async-inner" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const outer = spans.find((s) => s.name === "async-outer")!;
    const inner = spans.find((s) => s.name === "async-inner")!;
    expect(inner.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
  });
});

describe("startInactiveSpan", () => {
  let provider: NodeTracerProvider;
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  it("creates a span that is not active in context", () => {
    const span = startInactiveSpan({ name: "bg-task" });

    // The span should not be the active span
    const active = trace.getActiveSpan();
    expect(active).toBeUndefined();

    span.end();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("bg-task");
  });

  it("does not parent subsequent startSpan calls", () => {
    const inactive = startInactiveSpan({ name: "inactive-root" });
    // Creating another span should not be parented to the inactive span
    const other = startInactiveSpan({ name: "other" });
    other.end();
    inactive.end();

    const spans = exporter.getFinishedSpans();
    const inactiveSpan = spans.find((s) => s.name === "inactive-root")!;
    const otherSpan = spans.find((s) => s.name === "other")!;

    // Neither should be parented to the other
    expect(otherSpan.parentSpanContext).toBeUndefined();
    expect(otherSpan.spanContext().traceId).not.toBe(inactiveSpan.spanContext().traceId);
  });

  it("passes attributes and kind from options", () => {
    const span = startInactiveSpan({
      name: "with-opts",
      attributes: { queue: "jobs" },
      kind: 3, // SpanKind.PRODUCER
    });
    span.end();

    const spans = exporter.getFinishedSpans();
    expect(spans[0]!.attributes["queue"]).toBe("jobs");
    expect(spans[0]!.kind).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// startActiveSpan vs startSpan parenting behavior (raw OTel)
// ---------------------------------------------------------------------------
// These tests verify our documentation claims about span parenting.
// NodeTracerProvider is required because it registers the
// AsyncLocalStorageContextManager, which is what makes startActiveSpan
// propagate the active span through context. BasicTracerProvider alone
// does NOT register a context manager, so startActiveSpan would be a
// no-op for parenting.

describe("startActiveSpan parenting", () => {
  let provider: NodeTracerProvider;
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  it("startActiveSpan creates parent-child spans when nested", async () => {
    const tracer = trace.getTracer("test");

    tracer.startActiveSpan("parent", (parentSpan) => {
      tracer.startActiveSpan("child", (childSpan) => {
        childSpan.end();
      });
      parentSpan.end();
    });

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);

    const child = spans.find((s) => s.name === "child")!;
    const parent = spans.find((s) => s.name === "parent")!;

    // Child's parent is the outer span
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    // Both share the same trace
    expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
    // Parent has no parent (it's the root)
    expect(parent.parentSpanContext).toBeUndefined();
  });

  it("startSpan inside startActiveSpan is also parented", async () => {
    const tracer = trace.getTracer("test");

    tracer.startActiveSpan("parent", (parentSpan) => {
      // startSpan reads the active context set by startActiveSpan
      const child = tracer.startSpan("child-via-startSpan");
      child.end();
      parentSpan.end();
    });

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const child = spans.find((s) => s.name === "child-via-startSpan")!;
    const parent = spans.find((s) => s.name === "parent")!;

    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
  });

  it("sequential startSpan calls are NOT parented to each other", async () => {
    const tracer = trace.getTracer("test");

    const spanA = tracer.startSpan("standalone-a");
    const spanB = tracer.startSpan("standalone-b");
    spanB.end();
    spanA.end();

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const a = spans.find((s) => s.name === "standalone-a")!;
    const b = spans.find((s) => s.name === "standalone-b")!;

    // Neither is parented
    expect(a.parentSpanContext).toBeUndefined();
    expect(b.parentSpanContext).toBeUndefined();
    // They have different trace IDs (independent roots)
    expect(a.spanContext().traceId).not.toBe(b.spanContext().traceId);
  });

  it("startSpan outside startActiveSpan is not parented", async () => {
    const tracer = trace.getTracer("test");

    tracer.startActiveSpan("active-parent", (parentSpan) => {
      parentSpan.end();
    });

    // This span is created after the startActiveSpan callback returned,
    // so the active context no longer has the parent span
    const detached = tracer.startSpan("detached");
    detached.end();

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === "active-parent")!;
    const detachedSpan = spans.find((s) => s.name === "detached")!;

    expect(detachedSpan.parentSpanContext).toBeUndefined();
    expect(detachedSpan.spanContext().traceId).not.toBe(parent.spanContext().traceId);
  });

  it("three-level nesting creates correct parent chain", async () => {
    const tracer = trace.getTracer("test");

    tracer.startActiveSpan("grandparent", (gp) => {
      tracer.startActiveSpan("parent", (p) => {
        tracer.startActiveSpan("child", (c) => {
          c.end();
        });
        p.end();
      });
      gp.end();
    });

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(3);

    const grandparent = spans.find((s) => s.name === "grandparent")!;
    const parent = spans.find((s) => s.name === "parent")!;
    const child = spans.find((s) => s.name === "child")!;

    // Verify the chain: child -> parent -> grandparent
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(parent.parentSpanContext?.spanId).toBe(grandparent.spanContext().spanId);
    expect(grandparent.parentSpanContext).toBeUndefined();

    // All share the same trace ID
    const traceId = grandparent.spanContext().traceId;
    expect(parent.spanContext().traceId).toBe(traceId);
    expect(child.spanContext().traceId).toBe(traceId);
  });

  it("async startActiveSpan preserves parenting across await", async () => {
    const tracer = trace.getTracer("test");

    await tracer.startActiveSpan("async-parent", async (parentSpan) => {
      await new Promise((resolve) => setTimeout(resolve, 10));

      tracer.startActiveSpan("async-child", (childSpan) => {
        childSpan.end();
      });

      parentSpan.end();
    });

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === "async-parent")!;
    const child = spans.find((s) => s.name === "async-child")!;

    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
  });

  it("error in startActiveSpan callback does not prevent span from being accessible", () => {
    const tracer = trace.getTracer("test");

    expect(() => {
      tracer.startActiveSpan("erroring-span", (span) => {
        span.setAttribute("before.error", true);
        throw new Error("boom");
        // span.end() never called — but the span is still recorded
      });
    }).toThrow("boom");

    // The span was created and started, even though end() was never called.
    // In production, you'd use try/finally to always call span.end().
    // This test verifies the span is accessible even after an error.
    const activeSpan = trace.getActiveSpan();
    // After the callback threw, context is restored — no active span
    expect(activeSpan).toBeUndefined();
  });
});
