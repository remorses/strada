import { describe, it, expect, beforeEach } from "vitest";
import {
  normalizeError,
  shouldIgnoreError,
  errorToAttributes,
  setUser,
  setTags,
  resetContext,
  DEFAULT_IGNORE_ERRORS,
  DEFAULT_DENY_URLS,
} from "./shared.ts";

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

    expect(attrs["exception.type"]).toBe("TypeError");
    expect(attrs["exception.message"]).toBe("boom");
    expect(attrs["exception.stacktrace"]).toBeTruthy();
    expect(attrs["exception.mechanism.type"]).toBe("generic");
    expect(attrs["exception.mechanism.handled"]).toBe("true");
  });

  it("marks unhandled errors correctly", () => {
    const err = new Error("crash");
    const attrs = errorToAttributes(err, { handled: false });

    expect(attrs["exception.mechanism.type"]).toBe("onerror");
    expect(attrs["exception.mechanism.handled"]).toBe("false");
  });

  it("extracts fingerprint from options", () => {
    const err = new Error("timeout");
    const attrs = errorToAttributes(err, {
      fingerprint: ["db-timeout", "users-service"],
    });

    expect(attrs["exception.fingerprint"]).toBe(
      '["db-timeout","users-service"]',
    );
  });

  it("extracts fingerprint from error.fingerprint property", () => {
    const err = new Error("checkout failed") as Error & {
      fingerprint: string[];
    };
    err.fingerprint = ["checkout-failed", "processOrder"];
    const attrs = errorToAttributes(err);

    expect(attrs["exception.fingerprint"]).toBe(
      '["checkout-failed","processOrder"]',
    );
  });

  it("prefers options fingerprint over error.fingerprint", () => {
    const err = new Error("fail") as Error & { fingerprint: string[] };
    err.fingerprint = ["from-error"];
    const attrs = errorToAttributes(err, {
      fingerprint: ["from-options"],
    });

    expect(attrs["exception.fingerprint"]).toBe('["from-options"]');
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

    expect(attrs["user.id"]).toBe("user_42");
    expect(attrs["user.email"]).toBe("tommy@acme.com");
  });

  it("does not include user attributes when user is not set", () => {
    const err = new Error("fail");
    const attrs = errorToAttributes(err);

    expect(attrs["user.id"]).toBeUndefined();
    expect(attrs["user.email"]).toBeUndefined();
  });
});
