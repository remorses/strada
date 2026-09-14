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

import { logs, SeverityNumber } from "@opentelemetry/api-logs";
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
  /**
   * Whether to export telemetry to the ingest endpoint.
   *
   * Defaults to `false` in dev mode (`import.meta.hot` is truthy, e.g. Vite,
   * Webpack HMR, RSC dev servers) and `true` otherwise. Set explicitly to
   * override the default in either direction.
   *
   * `enabled: false` is a full kill switch for both product analytics and
   * error reporting. The providers are still installed, so `track()`,
   * `captureException()`, `getLogger()`, and `startSpan()` keep working and
   * drop their data. Never guard your own SDK calls behind an app-level flag;
   * pass the flag here once instead.
   *
   * A blank `projectId` also disables export, so reading the id from a secret
   * that may be missing is safe without extra checks.
   */
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
  /**
   * Bridge OTel spans to Cloudflare's native tracing (`tracing.enterSpan`).
   *
   * Only applies to the `@strada.sh/sdk` cloudflare entry point (workerd
   * condition). When enabled, every `startActiveSpan()` call also creates a
   * Cloudflare native span so custom spans appear in the Cloudflare trace
   * waterfall alongside auto-instrumented KV/D1/fetch spans.
   *
   * Auto-enabled when `tracing.enterSpan` is available at runtime.
   * Set to `false` to disable bridging and only export via OTLP.
   */
  cloudflareTracing?: boolean;
}

export interface StradaUserIdentity {
  /** Stable application user id. Written to cookie `strada_uid` in the browser. */
  id: string;
  /** User email. PII, emitted only through explicit identifyUser profile events. */
  email?: string;
  /** Display name or username. */
  name?: string;
  /** Full human-readable name. */
  fullName?: string;
  /** Stable anonymized user hash when raw ids are sensitive. */
  hash?: string;
  /** Profile image URL. */
  image?: string;
  /** Product/account organization id for this user profile. */
  organizationId?: string;
  /** Product/account organization name for this user profile. */
  organizationName?: string;
  /** Additional low-cardinality profile attributes. */
  attributes?: Record<string, string>;
}

export interface TrackPageviewOptions {
  /** Page pathname, e.g. "/pricing". Required. */
  path: string;
  /** Full page URL, e.g. "https://acme.com/pricing?plan=pro". */
  url?: string;
  /** Query string, e.g. "?plan=pro". Derived from url if not set. */
  query?: string;
  /** Referrer URL or domain. */
  referrer?: string;
  /** Session ID. Falls back to baggage session.id from the active OTel context. */
  sessionId?: string;
  /** User ID. Falls back to baggage user.id from the active OTel context. */
  userId?: string;
  /** Extra span attributes to set on the pageview span. */
  attributes?: Record<string, string>;
}

/**
 * Build span attributes for a server-side trackPageview() call.
 * Shared by node.ts and cloudflare.ts.
 */
export function buildPageviewAttributes(
  opts: TrackPageviewOptions,
  baggage: import("@opentelemetry/api").Baggage | undefined,
): Record<string, string> {
  // MVs require session.id != ''; fall back to ephemeral UUID for bots
  const sessionId =
    opts.sessionId ??
    baggage?.getEntry(BAGGAGE_SESSION_ID)?.value ??
    `server:${crypto.randomUUID()}`;
  const userId =
    opts.userId ??
    baggage?.getEntry(BAGGAGE_USER_ID)?.value;

  // Only set url.full for absolute URLs; relative ones (Express req.url)
  // break domainWithoutWWW() in the MV
  let urlFull: string | undefined;
  let path = opts.path;
  let query = opts.query ?? "";

  if (opts.url) {
    try {
      const parsed = new URL(opts.url);
      urlFull = parsed.href;
      path ||= parsed.pathname;
      query ||= parsed.search;
    } catch {
      // Relative URL; extract path/query manually
      if (opts.url.startsWith("/")) {
        const qIdx = opts.url.indexOf("?");
        if (qIdx >= 0) {
          path ||= opts.url.slice(0, qIdx) || "/";
          query ||= opts.url.slice(qIdx);
        } else {
          path ||= opts.url;
        }
      }
    }
  }

  // opts.attributes spread first so canonical fields can't be overridden
  return {
    ...opts.attributes,
    [ATTR["url.path"]]: path,
    [ATTR["pageview.source"]]: "server",
    [ATTR["session.id"]]: sessionId,
    ...(urlFull ? { [ATTR["url.full"]]: urlFull } : {}),
    ...(query ? { [ATTR["url.query"]]: query } : {}),
    ...(opts.referrer ? { [ATTR["http.request.header.referer"]]: opts.referrer } : {}),
    ...(userId ? { [ATTR["user.id"]]: userId } : {}),
  };
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

/**
 * Warnings about SDK configuration run on every request in a worker or server,
 * so they are deduplicated by message. Reset by `resetContext()` for tests.
 *
 * Messages embed error text, which can be unique per call, so the set is
 * capped: a long-lived server must not accumulate them forever. Clearing on
 * overflow is deliberate, the alternative (stop warning) hides real failures.
 */
const _warnedMessages = new Set<string>();
const MAX_WARNED_MESSAGES = 200;

export function warnOnce(message: string): void {
  if (_warnedMessages.has(message)) return;
  if (_warnedMessages.size >= MAX_WARNED_MESSAGES) _warnedMessages.clear();
  _warnedMessages.add(message);
  warnSafely(message);
}

/**
 * `console` is not guaranteed: it can be stripped, replaced by app code, or
 * throw from a patched `warn`. Diagnostics must never be the thing that
 * crashes an app inside the no-throw boundary below.
 */
function warnSafely(message: string): void {
  try {
    globalThis.console?.warn?.(message);
  } catch {
    // nothing left to do, the console itself is broken
  }
}

/**
 * `error.message` is a getter that app code controls, so reading it inside a
 * catch handler can throw a second time.
 */
function messageSafely(error: Error): string {
  try {
    const message = error.message;
    return typeof message === "string" ? message : "unknown telemetry error";
  } catch {
    return "unknown telemetry error";
  }
}

/**
 * `normalizeError` starts with `value instanceof Error`, and `instanceof`
 * walks the prototype chain, which a Proxy `getPrototypeOf` trap can throw
 * from. The catch handler of the boundary cannot afford that.
 */
function toErrorSafely(value: unknown): Error {
  try {
    return normalizeError(value);
  } catch {
    return new Error("unknown telemetry error");
  }
}

/**
 * Boundary between the throwing world and the SDK's public API.
 *
 * Telemetry must never take an app down. A dropped event is an acceptable
 * outcome, an app crashing inside `captureException()` is not. Every public
 * entry point runs its body through this, so a throw becomes a **returned**
 * Error (errors as values) instead of propagating into app code.
 *
 * Most call sites ignore the return value, so the failure is also logged.
 * `warnOnce` keys on the message, which keeps a failing exporter from
 * flooding the console on every request.
 *
 * Every step of the failure path is itself guarded: normalizing the thrown
 * value, reading its message, and writing to the console can all throw on
 * hostile input, and a boundary that throws is not a boundary.
 *
 * This is the only place the SDK catches: everything above it returns errors.
 */
function handleTelemetryFailure(operation: string, thrown: unknown): Error {
  const error = toErrorSafely(thrown);
  warnOnce(`[@strada.sh/sdk] ${operation} failed: ${messageSafely(error)}`);
  return error;
}

export function tryTelemetry({
  operation,
  run,
}: {
  operation: string;
  run: () => void;
}): Error | undefined {
  try {
    run();
    return undefined;
  } catch (thrown) {
    return handleTelemetryFailure(operation, thrown);
  }
}

/** Async variant of `tryTelemetry`, for `flush()` and `shutdown()`. */
export async function tryTelemetryAsync({
  operation,
  run,
}: {
  operation: string;
  run: () => Promise<void>;
}): Promise<Error | undefined> {
  // run() itself can throw synchronously before returning a promise.
  const started = ((): Promise<void> | Error => {
    try {
      return run();
    } catch (thrown) {
      return handleTelemetryFailure(operation, thrown);
    }
  })();
  if (started instanceof Error) return started;

  return started
    .then(() => undefined)
    .catch((thrown: unknown) => handleTelemetryFailure(operation, thrown));
}

export function setTags(tags: Record<string, string>): void {
  _tags = { ..._tags, ...tags };
}

export function getTags(): Record<string, string> {
  return _tags;
}

export function resetContext(): void {
  _tags = {};
  _warnedMessages.clear();
  resetRuntimeUserId();
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
/**
 * Every conversion here runs on a value the app threw, so it can be anything:
 * a circular object (`JSON.stringify` throws), a Proxy with a throwing get
 * trap (`Reflect.get` throws), an object with a throwing `toString`
 * (`String()` throws). A crash inside the error reporter would replace the
 * app's real error with a Strada one, so every step falls back instead.
 */
function describeUnknownValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === "string") return serialized;
  } catch {
    // circular structure, BigInt, or a throwing toJSON
  }
  try {
    return String(value);
  } catch {
    // throwing toString / Symbol.toPrimitive
  }
  return `[unserializable ${typeof value}]`;
}

export function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  if (typeof value === "object" && value !== null) {
    const message = (() => {
      try {
        return Reflect.get(value, "message");
      } catch {
        return undefined;
      }
    })();
    return new Error(
      typeof message === "string" ? message : describeUnknownValue(value),
    );
  }
  return new Error(describeUnknownValue(value));
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
 * Lightweight captureException that works via the global OTel logger API.
 * Unlike the runtime-specific versions in node.ts/browser.ts/cloudflare.ts,
 * this does not check _options (ignoreErrors, beforeSend) or _logger (the
 * runtime-initialized logger). It uses `logs.getLogger()` directly, which
 * works after `initStrada()` has registered OTel providers.
 *
 * Designed for use by plugins (e.g. better-auth plugin) that import from
 * shared.ts and can't import runtime-specific modules.
 */
export function captureExceptionViaOtel(
  error: unknown,
  opts?: CaptureExceptionOptions & { loggerName?: string },
): Error | undefined {
  return tryTelemetry({
    operation: "captureExceptionViaOtel()",
    run: () => {
      const normalized = normalizeError(error);
      const attributes = errorToAttributes(normalized, opts);
      const logger = logs.getLogger(opts?.loggerName ?? "strada");
      logger.emit({
        eventName: "exception",
        severityNumber: ERROR_SEVERITY,
        severityText: ERROR_SEVERITY_TEXT,
        body: normalized.message,
        attributes,
      });
    },
  });
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
/**
 * `beforeSend` is app code running inside the error reporter. If it throws,
 * report the original error rather than losing it, and say so once.
 */
export function applyBeforeSend(
  error: Error,
  beforeSend: StradaOptions["beforeSend"] | undefined,
): Error | null {
  if (!beforeSend) return error;
  try {
    return beforeSend(error) ?? null;
  } catch (thrown) {
    warnOnce(
      `[@strada.sh/sdk] beforeSend threw, sending the original error instead: ${normalizeError(thrown).message}`,
    );
    return error;
  }
}

// ---------------------------------------------------------------------------
// Dev mode detection and fast-flush defaults
// ---------------------------------------------------------------------------
// When import.meta.hot is truthy (Vite, Webpack HMR, RSC dev servers),
// telemetry export is disabled by default so development doesn't send
// data to the ingest endpoint. Users can override with `enabled: true`.
//
// When export IS enabled in dev mode (explicit opt-in), batch processors
// use aggressive flush intervals so logs, traces, and errors appear
// almost instantly. User-provided telemetry options always take highest
// priority over dev defaults.
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
/**
 * Logger methods never throw. They stay `void` because `StradaLogger` extends
 * the OTel `Logger` interface, whose `emit` is `void`; a different return type
 * on the sibling methods would only be confusing. Failures are logged by
 * `tryTelemetry`. Use `captureException()` when you need the error back.
 */
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
  // Logging must never take the app down either: a log argument can be a
  // circular object, a Proxy, or anything else with a throwing accessor.
  const emitConsoleLog = (method: LogSeverityMethod, args: unknown[]) =>
    tryTelemetry({
      operation: `logger.${method}()`,
      run: () => {
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
      },
    });

  return {
    emit: (record) =>
      tryTelemetry({
        operation: "logger.emit()",
        run: () => {
          const logger = getOtelLogger(name);
          if (!logger) {
            console.warn(
              "[@strada.sh/sdk] logger.emit() called before initStrada(). Log was not sent.",
            );
            return;
          }
          logger.emit(record);
        },
      }),
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

/** Default cookie name for the signed-in account. */
export const DEFAULT_USER_ID_COOKIE = "strada_uid";
export const DEFAULT_USER_ID_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
/** Default cookie name for the anonymous visitor. */
export const DEFAULT_VISITOR_COOKIE = "strada_vid";
export const DEFAULT_VISITOR_COOKIE_MAX_AGE = DEFAULT_USER_ID_COOKIE_MAX_AGE;
export const USER_IDENTIFY_EVENT_NAME = ATTR["strada.user.identify"];

let _runtimeUserId: string | null | undefined;

export function setRuntimeUserId(userId: string | null | undefined): void {
  _runtimeUserId = userId;
}

export function resetRuntimeUserId(): void {
  _runtimeUserId = undefined;
}

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

/**
 * Writing `document.cookie` throws a SecurityError inside a sandboxed iframe
 * without `allow-same-origin`, which is how plugin and widget hosts embed
 * apps. Losing the cookie there is fine, crashing is not.
 */
function writeCookie(value: string): void {
  if (typeof document === "undefined") return;
  try {
    document.cookie = value;
  } catch {
    // sandboxed iframe or cookies blocked by the user
  }
}

export function writeUserIdCookie({
  name = DEFAULT_USER_ID_COOKIE,
  value,
  maxAge = DEFAULT_USER_ID_COOKIE_MAX_AGE,
}: {
  name?: string;
  value: string;
  maxAge?: number;
}): void {
  writeCookie(
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=${maxAge}`,
  );
}

export function clearUserIdCookie(name = DEFAULT_USER_ID_COOKIE): void {
  writeCookie(`${encodeURIComponent(name)}=; Path=/; SameSite=Lax; Max-Age=0`);
}

export function writeVisitorCookie({
  name = DEFAULT_VISITOR_COOKIE,
  value,
  maxAge = DEFAULT_VISITOR_COOKIE_MAX_AGE,
}: {
  name?: string;
  value: string;
  maxAge?: number;
}): void {
  writeCookie(
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=${maxAge}`,
  );
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
 * 1. identifyUser() runtime override
 * 2. StradaOptions.userId (explicit override, static or dynamic)
 * 3. userIdCookie (persisted, set by backend) — browser only
 * 4. undefined
 */
export function resolveUserId(options: StradaOptions | undefined): string | undefined {
  if (_runtimeUserId !== undefined) {
    return _runtimeUserId ?? undefined;
  }

  if (options?.userId) {
    if (typeof options.userId === "function") {
      const fromFn = options.userId();
      if (fromFn !== undefined) return fromFn;
    } else {
      return options.userId;
    }
  }

  if (options?.userIdCookie !== false) {
    const cookieName = typeof options?.userIdCookie === "string"
      ? options.userIdCookie
      : DEFAULT_USER_ID_COOKIE;
    const fromCookie = readCookie(cookieName);
    if (fromCookie) return fromCookie;
  }

  return undefined;
}

export function userIdentityToAttributes(user: StradaUserIdentity): Record<string, string> {
  return {
    [ATTR["user.id"]]: user.id,
    ...(user.email ? { [ATTR["user.email"]]: user.email } : {}),
    ...(user.name ? { [ATTR["user.name"]]: user.name } : {}),
    ...(user.fullName ? { [ATTR["user.full_name"]]: user.fullName } : {}),
    ...(user.hash ? { [ATTR["user.hash"]]: user.hash } : {}),
    ...(user.image ? { [ATTR["user.image"]]: user.image } : {}),
    ...(user.organizationId ? { [ATTR["organization.id"]]: user.organizationId } : {}),
    ...(user.organizationName ? { [ATTR["organization.name"]]: user.organizationName } : {}),
    ...Object.fromEntries(
      Object.entries(user.attributes ?? {}).map(([key, value]) => [`strada.user.attributes.${key}`, value]),
    ),
  };
}

export function createUserIdentifyAttributes(user: StradaUserIdentity): Record<string, string> {
  return {
    [ATTR["event.name"]]: USER_IDENTIFY_EVENT_NAME,
    ...userIdentityToAttributes(user),
  };
}

export function emitUserIdentifyLog(
  logger: Pick<OtelLogger, "emit"> | undefined,
  user: StradaUserIdentity,
): boolean {
  if (!logger) return false;

  logger.emit({
    eventName: USER_IDENTIFY_EVENT_NAME,
    severityNumber: INFO_SEVERITY,
    severityText: INFO_SEVERITY_TEXT,
    body: USER_IDENTIFY_EVENT_NAME,
    attributes: createUserIdentifyAttributes(user),
  });
  return true;
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

/**
 * Decide whether this process should send anything to the ingest endpoint.
 *
 * When this returns false, `initStrada()` still installs the OTel providers,
 * just without any exporter. Every API keeps working and silently drops its
 * data: `track()`, `captureException()`, `getLogger()`, `startSpan()`. That is
 * deliberate, so apps never need to wrap SDK calls in their own `if (enabled)`
 * guards or skip `initStrada()` and then hit "called before initStrada()".
 */
export function shouldExportTelemetry(options: StradaOptions): boolean {
  // Checked before the projectId warning: telemetry turned off on purpose is
  // not a misconfiguration, so `{ projectId: '', enabled: false }` stays quiet.
  if (options.enabled === false) return false;

  // A blank projectId cannot be exported to: the default endpoint is derived
  // from it. Apps read it from an env var or a platform secret that can be
  // missing locally or in a half configured deployment, so treat it as "off"
  // instead of posting to https://-ingest.strada.sh.
  if (!options.projectId?.trim() && !options.endpoint?.trim()) {
    warnOnce(
      "[@strada.sh/sdk] initStrada() called without a projectId. Telemetry is disabled and all SDK calls are no-ops.",
    );
    return false;
  }
  if (options.enabled !== undefined) return options.enabled;
  // Disable export by default in dev mode (import.meta.hot present).
  // Users can override with `enabled: true` to force export during development.
  if (isDevMode()) return false;
  return true;
}

export const BAGGAGE_SESSION_ID = "strada.session.id";
export const BAGGAGE_USER_ID = "user.id";

/**
 * Attribute keys to extract from the active span into log records.
 * These carry request-scoped context (URL, HTTP method) that helps
 * understand where an error or event happened on the server.
 *
 * The BaggageLogProcessor in node.ts and cloudflare.ts reads these
 * from the active span and injects them into every log record, so
 * captureException() and track() calls inside HTTP handlers
 * automatically include the request URL without app code doing anything.
 *
 * "Only set if not already present" prevents overwriting values set by
 * the browser ContextLogProcessor or user code.
 */
export const SPAN_CONTEXT_ATTR_KEYS: string[] = [
  ATTR["url.path"],
  ATTR["url.full"],
  ATTR["url.query"],
  "http.route",          // route pattern, e.g. "/users/:id"
  "http.request.method", // new OTel semconv (v1.20+)
  "http.method",         // old OTel semconv (pre-v1.20)
  "http.target",         // old semconv, includes path + query
  "http.url",            // old semconv, full URL
];

/**
 * Read the `.attributes` object from an SDK span at runtime.
 * The OTel API `Span` interface only exposes `setAttribute()`, but the
 * SDK `Span` class always has a readable `.attributes` property. This
 * helper safely duck-types it so callers don't need `as unknown as ...`.
 */
export function readSpanAttributes(
  span: unknown,
): Record<string, unknown> | undefined {
  if (span != null && typeof span === "object" && "attributes" in span) {
    return (span as { attributes: Record<string, unknown> }).attributes;
  }
  return undefined;
}

/**
 * Derive `url.path` from old HTTP semantic conventions when the new
 * `url.path` attribute is not present.
 *
 * Normalization chain:
 * 1. `url.path` (new semconv) - use as-is
 * 2. `http.target` (old semconv) - strip query string
 * 3. `http.url` (old semconv) - parse URL, extract pathname
 *
 * Returns undefined if no URL can be derived.
 */
export function deriveUrlPath(
  attrs: Record<string, unknown>,
): string | undefined {
  const direct = attrs[ATTR["url.path"]];
  if (typeof direct === "string" && direct) return direct;

  const target = attrs["http.target"];
  if (typeof target === "string" && target) {
    const qIdx = target.indexOf("?");
    return qIdx >= 0 ? target.slice(0, qIdx) || "/" : target;
  }

  const oldUrl = attrs["http.url"];
  if (typeof oldUrl === "string" && oldUrl) {
    try {
      return new URL(oldUrl).pathname;
    } catch {
      // malformed URL, skip
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// startSpan — ergonomic span creation (Sentry-style)
// ---------------------------------------------------------------------------
// Uses a hidden global tracer so users never need to call trace.getTracer().
// Auto-ends the span and auto-records errors. Handles both sync and async
// callbacks by detecting thenables (same approach as OTel's SugaredTracer).

import type { SpanOptions as OtelSpanOptions } from "@opentelemetry/api";

export type StartSpanOptions = OtelSpanOptions & {
  /** Span name. Required. */
  name: string;
};


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
  const { name, ...spanOptions } = options;

  return tracer.startActiveSpan(name, spanOptions, (span) => {
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
 * An OTel Span that implements `Disposable` for use with the `using` keyword.
 * All standard Span methods are delegated to the underlying span.
 * When the block exits, `Symbol.dispose` calls `span.end()` automatically.
 *
 * @example
 * ```ts
 * {
 *   using span = startInactiveSpan({ name: 'bg-task' })
 *   span.setAttribute('queue', 'jobs')
 * } // span.end() called automatically
 * ```
 */
export type DisposableSpan = OtelSpan & Disposable;

/**
 * Create a span without setting it as active in context.
 *
 * The returned span implements `Disposable`, so it can be used with
 * the `using` keyword for automatic `span.end()` on scope exit.
 * You can also call `span.end()` manually if you prefer.
 *
 * Use this for background or parallel work that should not parent
 * child spans created in the current context.
 *
 * @example
 * ```ts
 * // with using — span.end() called automatically
 * {
 *   using span = startInactiveSpan({ name: 'bg-task' })
 *   span.setAttribute('queue', 'jobs')
 * }
 *
 * // without using — call span.end() yourself
 * const span = startInactiveSpan({ name: 'bg-task' })
 * doWork().finally(() => span.end())
 * ```
 */
export function startInactiveSpan(options: StartSpanOptions): DisposableSpan {
  const tracer = _trace.getTracer("strada");
  const { name, ...spanOptions } = options;
  const span = tracer.startSpan(name, spanOptions);
  (span as DisposableSpan)[Symbol.dispose] = () => span.end();
  return span as DisposableSpan;
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

  // Detect thenables (Promises) robustly. Access .then inside a try
  // so a throwing getter doesn't leak the span (onFinally not called).
  if (result != null && (typeof result === "object" || typeof result === "function")) {
    let thenFn: unknown;
    try {
      thenFn = (result as unknown as PromiseLike<unknown>).then;
    } catch (e) {
      onError(e);
      onFinally();
      throw e;
    }

    if (typeof thenFn === "function") {
      return thenFn.call(
        result,
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
