/**
 * Shared types, error normalization, attribute building, and filtering logic
 * used by both Node and browser entries. This is the core of the SDK; the
 * runtime-specific files (node.ts, browser.ts) are thin wrappers that wire
 * OTel providers and install global error handlers.
 *
 * After initStrada(), the global OTel providers are registered. Users can
 * use standard OTel APIs (trace.getTracer(), logs.getLogger(), etc.) directly.
 * The convenience helpers here (captureException, track) are optional sugar.
 */

import { SeverityNumber } from "@opentelemetry/api-logs";
import type { BatchLogRecordProcessorBrowserConfig } from "@opentelemetry/sdk-logs";
import type { PeriodicExportingMetricReaderOptions } from "@opentelemetry/sdk-metrics";
import type { BatchSpanProcessorBrowserConfig } from "@opentelemetry/sdk-trace-base";

// ---------------------------------------------------------------------------
// Re-export OTel API primitives so users don't need @opentelemetry/api
// ---------------------------------------------------------------------------

import { propagation as _propagation } from "@opentelemetry/api";
export { trace, context, metrics, propagation, diag, SpanStatusCode, SpanKind } from "@opentelemetry/api";
export type { Tracer, Span, SpanContext, SpanOptions, SpanAttributes, Baggage } from "@opentelemetry/api";
export { SeverityNumber } from "@opentelemetry/api-logs";
export { logs } from "@opentelemetry/api-logs";
export type { Logger } from "@opentelemetry/api-logs";
export type { BatchLogRecordProcessorBrowserConfig } from "@opentelemetry/sdk-logs";
export type { PeriodicExportingMetricReaderOptions } from "@opentelemetry/sdk-metrics";
export type { BatchSpanProcessorBrowserConfig } from "@opentelemetry/sdk-trace-base";

// ---------------------------------------------------------------------------
// OTel attribute keys used by the Strada SDK
// ---------------------------------------------------------------------------
// All custom attribute names in one place. Some are standard OTel semantic
// conventions (exception.*, url.*), some are Strada additions (session.id,
// event.name, navigation.*). Centralizing them prevents typos, makes
// renaming safe, and documents what each attribute is for.

export const ATTR = {
  // -- Session and user context (injected by browser SDK, propagated via baggage) --

  /** Per-tab browser session UUID, stored in sessionStorage. Groups pageviews, events, and errors into one visit. */
  "session.id": "session.id",
  /** Signed-in user identity from StradaOptions.userId, cookie, or propagated baggage. Correlates telemetry across sessions. */
  "enduser.id": "enduser.id",

  // -- URL context (injected by browser SDK into every span and log) --

  /** Current page pathname, e.g. "/pricing". From window.location.pathname. */
  "url.path": "url.path",
  /** Current page query string, e.g. "?plan=pro". From window.location.search. */
  "url.query": "url.query",
  /** Full page URL including protocol, host, path, query. From window.location.href. */
  "url.full": "url.full",
  /** Referrer URL. From document.referrer. Useful for entry page attribution. */
  "http.request.header.referer": "http.request.header.referer",

  // -- Custom events (track API) --

  /** Structured event name that distinguishes custom events from ordinary logs, e.g. "signup_started". */
  "event.name": "event.name",

  // -- Exception attributes (standard OTel + Strada extensions) --

  /** Fully-qualified exception class name, e.g. "TypeError". Standard OTel. */
  "exception.type": "exception.type",
  /** The exception message string. Standard OTel. */
  "exception.message": "exception.message",
  /** Raw stacktrace string in the language's natural format. Standard OTel. */
  "exception.stacktrace": "exception.stacktrace",
  /** How the exception was captured: "generic", "onerror", "unhandledrejection", "uncaughtException". */
  "exception.mechanism.type": "exception.mechanism.type",
  /** "true" if user code caught it, "false" if caught by a global handler. String, not boolean. */
  "exception.mechanism.handled": "exception.mechanism.handled",
  /** Custom fingerprint override for issue grouping. JSON array string. */
  "exception.fingerprint": "exception.fingerprint",

  // -- SPA navigation (set on pageview spans during client-side navigation) --

  /** How the navigation was triggered: "push", "replace", "traverse". From Navigation API. */
  "navigation.type": "navigation.type",
  /** Whether the user clicked a link vs programmatic navigation. Boolean. */
  "navigation.user_initiated": "navigation.user_initiated",

  // -- Browser detection (set as resource attributes on SDK init) --

  /** OS platform, e.g. "macOS", "Windows". From navigator.userAgentData.platform. */
  "browser.platform": "browser.platform",
  /** Brand strings, e.g. "Google Chrome 147, Chromium 147". From navigator.userAgentData.brands. */
  "browser.brands": "browser.brands",
  /** Whether the device is mobile. From navigator.userAgentData.mobile. */
  "browser.mobile": "browser.mobile",
  /** Browser language, e.g. "en-US". From navigator.language. */
  "browser.language": "browser.language",
  /** Full user agent string. From navigator.userAgent. */
  "user_agent.original": "user_agent.original",

  // -- Resource attributes (standard OTel semantic conventions) --

  /** Logical name of the service, e.g. "api", "frontend". Standard OTel resource attribute. */
  "service.name": "service.name",
  /** Version of the service/app. Maps to Release in error tracking. Standard OTel resource attribute. */
  "service.version": "service.version",
  /** Deployment environment, e.g. "production", "staging". Standard OTel resource attribute. */
  "deployment.environment.name": "deployment.environment.name",
} as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StradaMetricReaderOptions = Omit<
  PeriodicExportingMetricReaderOptions,
  "exporter" | "metricProducers"
>;

export interface StradaTelemetryOptions {
  /** Batch processor options for traces. Reuses OTel's browser batch config shape. */
  traces?: BatchSpanProcessorBrowserConfig;
  /** Batch processor options for logs. Reuses OTel's browser batch config shape. */
  logs?: BatchLogRecordProcessorBrowserConfig;
  /** Metric reader cadence options. Reuses OTel's PeriodicExportingMetricReader shape, minus exporter internals. */
  metrics?: StradaMetricReaderOptions;
}

export interface StradaOptions {
  /** Strada project identifier. Used to construct the default ingest endpoint. */
  projectId: string;
  /** service.name resource attribute */
  service: string;
  /** Override the ingest endpoint. Defaults to https://{projectId}-ingest.strada.sh */
  endpoint?: string;
  /** service.version resource attribute (maps to Release in error tracking) */
  version?: string;
  /** deployment.environment.name resource attribute */
  environment?: string;
  /** Drop errors whose message matches any of these patterns */
  ignoreErrors?: Array<string | RegExp>;
  /** Drop errors whose top stack frame URL matches any of these patterns */
  denyUrls?: Array<string | RegExp>;
  /** Return null to drop an error before it is sent */
  beforeSend?: (error: Error) => Error | null;
  /** Enable OTel diagnostic logging */
  debug?: boolean;
  /** Advanced OTel batching and export cadence options. */
  telemetry?: StradaTelemetryOptions;
  /**
   * Dynamic user ID resolver (browser only).
   * Called on every span/log to get the current user ID.
   * Use this when user ID changes at runtime (e.g. after login).
   */
  userId?: string | (() => string | undefined);
  /**
   * Cookie name to read user ID from (browser only).
   * The SDK reads this cookie on every span/log as a fallback when
   * `userId` has not been set.
   *
   * Set your backend to write this cookie after login (e.g. from
   * better-auth's session hook). The cookie must be JS-readable
   * (not httpOnly).
   *
   * Default: `"strada_uid"`. Set to `false` to disable cookie reading.
   */
  userIdCookie?: string | false;
}

export interface CaptureExceptionOptions {
  /** Was this error caught by user code (true) or a global handler (false)? */
  handled?: boolean;
  /** How the exception was captured, e.g. onerror or unhandledrejection */
  mechanism?: string;
  /** Extra tags attached to the error */
  tags?: Record<string, string>;
  /**
   * Custom fingerprint override for issue grouping.
   * When set, the ingest worker uses this instead of computing a default.
   */
  fingerprint?: string[];
}

// ---------------------------------------------------------------------------
// Shared context (tags only)
// ---------------------------------------------------------------------------

let _tags: Record<string, string> = {};

export function setTags(tags: Record<string, string>): void {
  _tags = { ..._tags, ...tags };
}

export function getTags(): Record<string, string> {
  return _tags;
}

export function resetContext(): void {
  _tags = {};
}

// ---------------------------------------------------------------------------
// Default noise patterns
// ---------------------------------------------------------------------------

/** Default error message patterns to ignore (browser junk, mostly) */
export const DEFAULT_IGNORE_ERRORS: RegExp[] = [
  /^Script error\.?$/,
  /^Javascript error: Script error\.? on line 0$/,
  /^ResizeObserver loop limit exceeded$/,
  /^ResizeObserver loop completed with undelivered notifications\.?$/,
  /^Cannot redefine property: googletag$/,
  /^Can't find variable: gmo$/,
  /^Non-Error promise rejection captured/,
];

/** Default URL patterns to deny (browser extensions) */
export const DEFAULT_DENY_URLS: RegExp[] = [
  /chrome-extension:\/\//,
  /moz-extension:\/\//,
  /safari-extension:\/\//,
  /safari-web-extension:\/\//,
];

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

/**
 * Ensure we always work with a proper Error object.
 * Wraps non-Error thrown values (strings, numbers, objects) into an Error.
 */
export function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  if (typeof value === "object" && value !== null) {
    const message = Reflect.get(value, "message");
    const msg =
      typeof message === "string"
        ? message
        : JSON.stringify(value);
    return new Error(msg);
  }
  return new Error(String(value));
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function matchesAny(
  value: string,
  patterns: Array<string | RegExp>,
): boolean {
  for (const pattern of patterns) {
    if (typeof pattern === "string") {
      if (value.includes(pattern)) return true;
    } else {
      if (pattern.test(value)) return true;
    }
  }
  return false;
}

/**
 * Determine whether an error should be ignored based on user config
 * and default noise patterns.
 */
export function shouldIgnoreError(
  error: Error,
  options: Pick<StradaOptions, "ignoreErrors" | "denyUrls">,
): boolean {
  const message = error.message || "";
  const stack = error.stack || "";

  // Check ignoreErrors (user patterns + defaults)
  const ignorePatterns = [
    ...DEFAULT_IGNORE_ERRORS,
    ...(options.ignoreErrors ?? []),
  ];
  if (matchesAny(message, ignorePatterns)) return true;

  // Check denyUrls against stack frames
  const denyPatterns = [...DEFAULT_DENY_URLS, ...(options.denyUrls ?? [])];
  if (denyPatterns.length > 0 && matchesAny(stack, denyPatterns)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Error -> OTel log attributes
// ---------------------------------------------------------------------------

/**
 * Convert an Error + capture options into the OTel log record attributes
 * that the Strada collector expects for error extraction.
 *
 * Attribute names follow the conventions documented in AGENTS.md:
 * - Standard OTel: exception.type, exception.message, exception.stacktrace
 * - Strada custom: exception.fingerprint, exception.mechanism.*
 */
export function errorToAttributes(
  error: Error,
  opts?: CaptureExceptionOptions,
): Record<string, string> {
  const fingerprintValue = Reflect.get(error, "fingerprint");
  const attributes: Record<string, string> = {
    [ATTR["exception.type"]]: error.name || "Error",
    [ATTR["exception.message"]]: error.message || "",
    [ATTR["exception.stacktrace"]]: error.stack ?? "",
    [ATTR["exception.mechanism.type"]]: opts?.mechanism ?? "generic",
    [ATTR["exception.mechanism.handled"]]: String(opts?.handled ?? true),
  };

  // Custom fingerprint from options or from error.fingerprint property
  const fingerprint =
    opts?.fingerprint ??
    (Array.isArray(fingerprintValue) ? fingerprintValue : undefined);
  if (fingerprint) {
    attributes[ATTR["exception.fingerprint"]] = JSON.stringify(fingerprint);
  }

  // Merge user-set tags
  const mergedTags = { ..._tags, ...(opts?.tags ?? {}) };
  for (const [k, v] of Object.entries(mergedTags)) {
    attributes[k] = v;
  }

  return attributes;
}

/**
 * Apply user beforeSend hook semantics consistently across runtimes.
 * Returning null drops the error. Returning a different Error rewrites it.
 */
export function applyBeforeSend(
  error: Error,
  beforeSend: StradaOptions["beforeSend"] | undefined,
): Error | null {
  if (!beforeSend) return error;
  const result = beforeSend(error);
  return result ?? null;
}

/**
 * Resolve metric reader options with the SDK default export interval.
 */
export function resolveMetricReaderOptions(
  options: StradaOptions,
): StradaMetricReaderOptions {
  return {
    exportIntervalMillis: 10_000,
    ...options.telemetry?.metrics,
  };
}

/**
 * The severity number used for all captured exceptions.
 * Re-exported so runtime entries don't need to import from api-logs directly.
 */
export const ERROR_SEVERITY = SeverityNumber.ERROR;
export const ERROR_SEVERITY_TEXT = "ERROR";
export const INFO_SEVERITY = SeverityNumber.INFO;
export const INFO_SEVERITY_TEXT = "INFO";

// ---------------------------------------------------------------------------
// Cookie reading
// ---------------------------------------------------------------------------

/** Default cookie name for user ID. */
export const DEFAULT_USER_ID_COOKIE = "strada_uid";

/**
 * Read a cookie value by name from document.cookie.
 * Returns undefined if the cookie doesn't exist or document is not available.
 */
export function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  try {
    const cookies = document.cookie;
    if (!cookies) return undefined;
    // Match `name=value` handling optional spaces after semicolons.
    // Cookie values are terminated by `;` or end-of-string.
    const match = cookies.match(new RegExp(`(?:^|;\\s*)${escapeRegExp(name)}=([^;]*)`));
    const value = match?.[1];
    return value ? decodeURIComponent(value) : undefined;
  } catch {
    return undefined;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Resolve userId from options
// ---------------------------------------------------------------------------

/**
 * Resolve the userId from StradaOptions.userId or cookie.
 *
 * Priority chain:
 * 1. StradaOptions.userId (explicit override, static or dynamic)
 * 2. userIdCookie (persisted, set by backend) — browser only
 * 3. undefined
 */
export function resolveUserId(options: StradaOptions | undefined): string | undefined {
  // 1. Explicit userId option (static string or dynamic resolver)
  if (options?.userId) {
    if (typeof options.userId === "function") {
      const fromFn = options.userId();
      // Only fall through when the function returns undefined (not set).
      // Empty string is a valid "no user" signal and should not fall back.
      if (fromFn !== undefined) return fromFn;
    } else {
      return options.userId;
    }
  }

  // 2. Cookie fallback (browser only)
  if (options?.userIdCookie !== false) {
    const cookieName = typeof options?.userIdCookie === "string"
      ? options.userIdCookie
      : DEFAULT_USER_ID_COOKIE;
    const fromCookie = readCookie(cookieName);
    if (fromCookie) return fromCookie;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Baggage propagation constants and helpers
// ---------------------------------------------------------------------------
// W3C Baggage is used to propagate session.id and enduser.id from browser to
// backend so that server-side spans and logs can be correlated to the
// browser session. The baggage header is injected by the W3CBaggagePropagator
// on every outgoing fetch/XHR, and extracted by the backend OTel SDK.

// ---------------------------------------------------------------------------
// Endpoint resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the ingest endpoint from StradaOptions.
 * If endpoint is provided, use it as-is. Otherwise derive from projectId.
 */
export function resolveEndpoint(options: StradaOptions): string {
  if (options.endpoint) {
    return options.endpoint.replace(/\/+$/, "");
  }
  return `https://${options.projectId}-ingest.strada.sh`;
}

export const BAGGAGE_SESSION_ID = "strada.session.id";
export const BAGGAGE_USER_ID = "enduser.id";

/**
 * Build a Baggage object with session.id and optionally enduser.id.
 * Used by the browser SDK to inject context into outgoing requests,
 * and by tests to simulate browser-to-server propagation.
 */
export function createStradaBaggage(
  sessionId: string,
  userId?: string,
): import("@opentelemetry/api").Baggage {
  const entries: Record<string, { value: string }> = {
    [BAGGAGE_SESSION_ID]: { value: sessionId },
  };
  if (userId) {
    entries[BAGGAGE_USER_ID] = { value: userId };
  }
  return _propagation.createBaggage(entries);
}
