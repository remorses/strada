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
import type { Logger as OtelLogger } from "@opentelemetry/api-logs";
import type { Context, Span as OtelSpan } from "@opentelemetry/api";
import type { BatchLogRecordProcessorBrowserConfig } from "@opentelemetry/sdk-logs";
import type { PeriodicExportingMetricReaderOptions } from "@opentelemetry/sdk-metrics";
import type { BatchSpanProcessorBrowserConfig } from "@opentelemetry/sdk-trace-base";
import { formatLogValue } from "#log-format";
import {
  formatLogValue as formatStructuredLogValue,
  truncateLogString,
} from "./log-format-json.ts";

// ---------------------------------------------------------------------------
// Re-export OTel API primitives so users don't need @opentelemetry/api
// ---------------------------------------------------------------------------

import {
  propagation as _propagation,
  trace as _trace,
  SpanStatusCode as _SpanStatusCode,
} from "@opentelemetry/api";
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
// Re-exported from attrs.ts (which has no DOM dependencies) so non-browser
// runtimes like the otel-collector can import ATTR directly from that file.

export { ATTR } from "./attrs.ts";
import { ATTR } from "./attrs.ts";

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
  /** Set to false to install local OTel providers without sending data to ingest. */
  enabled?: boolean;
  /** Override the ingest endpoint. Defaults to https://{projectId}-ingest.strada.sh */
  endpoint?: string;
  /** Server-side org token. Do not pass this from browser bundles. */
  token?: string;
  /** service.version resource attribute (maps to Release in error tracking) */
  version?: string;
  /** deployment.environment.name resource attribute */
  environment?: string;
  /** vcs.ref.head.revision resource attribute, usually the full git commit SHA. */
  releaseCommit?: string;
  /** vcs.ref.head.name resource attribute, usually the git branch or tag name. */
  releaseBranch?: string;
  /** deployment.id resource attribute, usually the platform deployment or build id. */
  deploymentId?: string;
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

export interface StradaReleaseMetadata {
  version?: string;
  commit?: string;
  branch?: string;
  deploymentId?: string;
}

declare global {
  var STRADA_RELEASE: StradaReleaseMetadata | undefined;
}

type EnvLike = Record<string, string | undefined>;

function firstEnv(env: EnvLike | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env?.[key];
    if (value) return value;
  }
  return undefined;
}

export function getInjectedStradaRelease(): StradaReleaseMetadata | undefined {
  return globalThis.STRADA_RELEASE;
}

export function resolveReleaseAttributes(
  options: StradaOptions,
  env?: EnvLike,
): Record<string, string> {
  const injected = getInjectedStradaRelease();
  const version =
    options.version ??
    firstEnv(env, [
      "STRADA_RELEASE_VERSION",
      "STRADA_RELEASE",
      "SENTRY_RELEASE",
      "npm_package_version",
    ]) ??
    injected?.version;
  const commit =
    options.releaseCommit ??
    firstEnv(env, [
      "STRADA_RELEASE_COMMIT",
      "VERCEL_GIT_COMMIT_SHA",
      "RENDER_GIT_COMMIT",
      "CF_PAGES_COMMIT_SHA",
      "WORKERS_CI_COMMIT_SHA",
      "GITHUB_SHA",
      "GIT_COMMIT",
      "CI_COMMIT_SHA",
    ]) ??
    injected?.commit;
  const branch =
    options.releaseBranch ??
    firstEnv(env, [
      "STRADA_RELEASE_BRANCH",
      "VERCEL_GIT_COMMIT_REF",
      "RENDER_GIT_BRANCH",
      "CF_PAGES_BRANCH",
      "WORKERS_CI_BRANCH",
      "GITHUB_HEAD_REF",
      "GITHUB_REF_NAME",
      "CI_COMMIT_BRANCH",
    ]) ??
    injected?.branch;
  const deploymentId =
    options.deploymentId ??
    firstEnv(env, [
      "STRADA_DEPLOYMENT_ID",
      "VERCEL_DEPLOYMENT_ID",
      "WORKERS_CI_BUILD_UUID",
      "RENDER_INSTANCE_ID",
      "FLY_MACHINE_VERSION",
      "GITHUB_RUN_ID",
    ]) ??
    injected?.deploymentId ??
    commit;

  return {
    ...(version ? { [ATTR["service.version"]]: version } : {}),
    ...(commit ? { [ATTR["vcs.ref.head.revision"]]: commit } : {}),
    ...(branch ? { [ATTR["vcs.ref.head.name"]]: branch } : {}),
    ...(deploymentId ? { [ATTR["deployment.id"]]: deploymentId } : {}),
  };
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
 * Record an escaping exception on a span using standard OTel trace semantics.
 *
 * Strada still emits exception logs as the source of truth, but marking the
 * active span keeps trace-only views honest when an uncaught exception fails
 * the operation. `recordException()` adds the standard `exception` span event;
 * `setStatus(ERROR)` marks the span failed because OTel does not do that
 * automatically when recording the exception event.
 */
export function recordExceptionOnSpan(
  error: Error,
  span: OtelSpan | undefined = _trace.getActiveSpan(),
): void {
  if (!span) return;

  span.recordException(error);
  span.setStatus({
    code: _SpanStatusCode.ERROR,
    message: error.message,
  });
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

// ---------------------------------------------------------------------------
// Dev mode detection and fast-flush defaults
// ---------------------------------------------------------------------------
// When import.meta.hot is truthy (Vite, Webpack HMR, RSC dev servers),
// batch processors use aggressive flush intervals so logs, traces, and
// errors appear almost instantly during development. User-provided
// telemetry options always take highest priority over dev defaults.
//
// Priority chain:  user telemetry options > dev defaults > OTel defaults

const DEV_BATCH_DEFAULTS = {
  scheduledDelayMillis: 500,
} as const;

const DEV_METRIC_DEFAULTS = {
  exportIntervalMillis: 2_000,
} as const;

function isDevMode(): boolean {
  try {
    return !!(import.meta as any).hot;
  } catch {
    return false;
  }
}

/**
 * Merge dev-mode fast-flush defaults underneath user-provided batch options.
 * In production (no import.meta.hot), returns user options unchanged.
 */
export function resolveBatchOptions<T extends { scheduledDelayMillis?: number }>(
  userOptions: T | undefined,
): T | { scheduledDelayMillis: number } | undefined {
  if (!isDevMode()) return userOptions;
  return { ...DEV_BATCH_DEFAULTS, ...userOptions };
}

/**
 * Resolve metric reader options with the SDK default export interval.
 */
export function resolveMetricReaderOptions(
  options: StradaOptions,
): StradaMetricReaderOptions {
  return {
    exportIntervalMillis: 10_000,
    ...(isDevMode() ? DEV_METRIC_DEFAULTS : {}),
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
// Console-style logging helpers
// ---------------------------------------------------------------------------

type LogAttributePrimitive = string | number | boolean;
type LogAttributes = Record<string, unknown>;
type LogMethod = (...args: unknown[]) => void;
type LogSeverityMethod = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface StradaLogger extends OtelLogger {
  trace: LogMethod;
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  fatal: LogMethod;
}

export interface NormalizedLogInput {
  body: string;
  attributes: Record<string, LogAttributePrimitive>;
}

const severityByMethod = {
  trace: [SeverityNumber.TRACE, "TRACE"],
  debug: [SeverityNumber.DEBUG, "DEBUG"],
  info: [SeverityNumber.INFO, "INFO"],
  warn: [SeverityNumber.WARN, "WARN"],
  error: [SeverityNumber.ERROR, "ERROR"],
  fatal: [SeverityNumber.FATAL, "FATAL"],
} as const satisfies Record<LogSeverityMethod, readonly [SeverityNumber, string]>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeLogAttribute(value: unknown): LogAttributePrimitive | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return truncateLogString(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  return formatStructuredLogValue(value);
}

function normalizeLogAttributes(input: LogAttributes): Record<string, LogAttributePrimitive> {
  const attributes: Record<string, LogAttributePrimitive> = {};
  for (const [key, value] of Object.entries(input)) {
    const normalized = normalizeLogAttribute(value);
    if (normalized !== undefined) attributes[key] = normalized;
  }
  return attributes;
}

export function normalizeLogInput(args: unknown[]): NormalizedLogInput {
  if (args.length === 1 && isPlainObject(args[0])) {
    const attributes = normalizeLogAttributes(args[0]);
    const message = attributes.message;
    return {
      body: typeof message === "string" ? message : formatStructuredLogValue(args[0]),
      attributes,
    };
  }

  return {
    body: args.map(formatLogValue).join(" "),
    attributes: {},
  };
}

export function createStradaLogger(
  getOtelLogger: (name: string) => OtelLogger | undefined,
  getContext?: () => Context | undefined,
  name = "strada",
): StradaLogger {
  const emitConsoleLog = (method: LogSeverityMethod, args: unknown[]) => {
    const logger = getOtelLogger(name);
    if (!logger) {
      console.warn(
        `[@strada.sh/sdk] logger.${method}() called before initStrada(). Log was not sent.`,
      );
      return;
    }

    const [severityNumber, severityText] = severityByMethod[method];
    const { body, attributes } = normalizeLogInput(args);
    const activeContext = getContext?.();

    logger.emit({
      severityNumber,
      severityText,
      body,
      attributes,
      ...(activeContext ? { context: activeContext } : {}),
    });
  };

  return {
    emit: (record) => {
      const logger = getOtelLogger(name);
      if (!logger) {
        console.warn(
          "[@strada.sh/sdk] logger.emit() called before initStrada(). Log was not sent.",
        );
        return;
      }
      logger.emit(record);
    },
    trace: (...args) => emitConsoleLog("trace", args),
    debug: (...args) => emitConsoleLog("debug", args),
    info: (...args) => emitConsoleLog("info", args),
    warn: (...args) => emitConsoleLog("warn", args),
    error: (...args) => emitConsoleLog("error", args),
    fatal: (...args) => emitConsoleLog("fatal", args),
  };
}

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
// W3C Baggage is used to propagate session.id and user.id from browser to
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
    return options.endpoint.replace(/\/+$/, "").toLowerCase();
  }
  return `https://${options.projectId}-ingest.strada.sh`.toLowerCase();
}

export function resolveIngestHeaders(options: StradaOptions): Record<string, string> | undefined {
  return options.token ? { Authorization: `Bearer ${options.token}` } : undefined;
}

export function shouldExportTelemetry(options: StradaOptions): boolean {
  return options.enabled !== false;
}

export const BAGGAGE_SESSION_ID = "strada.session.id";
export const BAGGAGE_USER_ID = "user.id";

// ---------------------------------------------------------------------------
// startSpan — ergonomic span creation (Sentry-style)
// ---------------------------------------------------------------------------
// Uses a hidden global tracer so users never need to call trace.getTracer().
// Auto-ends the span and auto-records errors. Handles both sync and async
// callbacks by detecting thenables (same approach as OTel's SugaredTracer).

export interface StartSpanOptions {
  /** Span name. Required. */
  name: string;
  /** Span attributes set at creation time. */
  attributes?: Record<string, string | number | boolean>;
  /** Span kind (SERVER, CLIENT, PRODUCER, CONSUMER, INTERNAL). */
  kind?: import("@opentelemetry/api").SpanKind;
}

/**
 * Start a span, execute the callback, and auto-end the span.
 *
 * The span is set as active in the current context (via AsyncLocalStorage on
 * Node, WorkerContextManager on Cloudflare, StackContextManager on browser).
 * Child spans created inside the callback are automatically parented to it.
 *
 * If the callback throws (sync or async), the span status is set to ERROR,
 * the exception is recorded on the span, and the error is re-thrown.
 * If the callback succeeds, the span ends normally.
 *
 * @example
 * ```ts
 * const result = await startSpan({ name: 'checkout' }, async (span) => {
 *   span.setAttribute('order.id', 'ord_123')
 *   return await processOrder()
 * })
 * ```
 */
export function startSpan<T>(
  options: StartSpanOptions,
  callback: (span: OtelSpan) => T,
): T {
  const tracer = _trace.getTracer("strada");
  const spanOptions: import("@opentelemetry/api").SpanOptions = {
    attributes: options.attributes,
    kind: options.kind,
  };

  return tracer.startActiveSpan(options.name, spanOptions, (span) => {
    return _handleCallbackErrors(
      () => callback(span),
      (e) => {
        span.recordException(e instanceof Error ? e : new Error(String(e)));
        span.setStatus({ code: _SpanStatusCode.ERROR });
      },
      () => span.end(),
    );
  });
}

/**
 * Create a span without setting it as active in context.
 *
 * The span is NOT auto-ended. You must call `span.end()` yourself.
 * Use this for background or parallel work that should not parent
 * child spans created in the current context.
 *
 * @example
 * ```ts
 * const span = startInactiveSpan({ name: 'bg-task' })
 * doWork().finally(() => span.end())
 * ```
 */
export function startInactiveSpan(options: StartSpanOptions): OtelSpan {
  const tracer = _trace.getTracer("strada");
  return tracer.startSpan(options.name, {
    attributes: options.attributes,
    kind: options.kind,
  });
}

/**
 * Execute a callback with error and cleanup hooks.
 * Handles both synchronous returns and thenables (Promises).
 *
 * - If fn() throws synchronously: onError(e), onFinally(), re-throw
 * - If fn() returns a thenable that rejects: onError(e), onFinally(), re-throw
 * - If fn() returns a thenable that resolves: onFinally(), return value
 * - If fn() returns a non-thenable: onFinally(), return value
 */
function _handleCallbackErrors<T>(
  fn: () => T,
  onError: (error: unknown) => void,
  onFinally: () => void,
): T {
  let result: T;
  try {
    result = fn();
  } catch (e) {
    onError(e);
    onFinally();
    throw e;
  }

  if (
    result != null &&
    typeof result === "object" &&
    "then" in result &&
    typeof (result as any).then === "function"
  ) {
    return (result as any).then(
      (val: unknown) => {
        onFinally();
        return val;
      },
      (err: unknown) => {
        onError(err);
        onFinally();
        throw err;
      },
    ) as T;
  }

  onFinally();
  return result;
}

/**
 * Build a Baggage object with session.id and optionally user.id.
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
