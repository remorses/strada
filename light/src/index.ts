/**
 * `@strada.sh/light`: a zero-dependency, explicit-only subset of `@strada.sh/sdk`.
 *
 * Switch by changing the import path. Same function names, same option
 * names, same rows in `otel_logs` / `otel_traces` (`event.name`, `custom.*`,
 * `exception.*`, `strada.user.identify`, `pageview`), so every Strada query
 * works unchanged. What the light build does not support is not exported or
 * not accepted, so a switch that relies on it fails at compile time instead
 * of silently dropping data. `index.test.ts` type-checks every export against
 * the full SDK to keep both in sync.
 *
 * Explicit only: nothing is captured unless you call it. `initStrada()`
 * installs nothing global: no OTel providers, no process or window error
 * handlers, no fetch patching, no resource detectors (no hostname, OS
 * username, or command args). Records are built as OTLP JSON by hand and
 * POSTed with `fetch` to `/v1/logs` and `/v1/traces`. The flush timer is
 * unref'd, so call `flush()` before a short-lived process exits.
 *
 * Span parenting across `await` uses AsyncLocalStorage when the runtime
 * exposes `process.getBuiltinModule` (Node 20.16+, Bun, Workers with
 * nodejs_compat). Elsewhere (browsers) only synchronous nesting works, the
 * same limitation as the full browser SDK.
 *
 * Every function follows "telemetry never throws": failures are returned as
 * values and logged once with console.warn. `startSpan()` rethrows the
 * callback's own error, like the full SDK.
 */

import type { AsyncLocalStorage } from "node:async_hooks";
import { ATTR } from "./attrs.ts";

export type AttributeValue = string | number | boolean;
export type Attributes = Record<string, AttributeValue>;

export interface StradaOptions {
  /** Strada project identifier. Blank disables sending. */
  projectId: string;
  /** service.name resource attribute */
  service: string;
  /** Kill switch. `false` makes every call a no-op. Defaults to true, false when import.meta.hot is set. */
  enabled?: boolean;
  /** Override the ingest endpoint. Defaults to https://{projectId}-ingest.strada.sh */
  endpoint?: string;
  /** Server-side ingest token. Omit in code shipped to users (npm CLIs, browsers). */
  token?: string;
  /** service.version resource attribute */
  version?: string;
  /** deployment.environment.name resource attribute */
  environment?: string;
  /** vcs.ref.head.revision resource attribute */
  releaseCommit?: string;
  /** vcs.ref.head.name resource attribute */
  releaseBranch?: string;
  /** deployment.id resource attribute. Defaults to releaseCommit. */
  deploymentId?: string;
  /** Drop errors whose message matches any of these patterns */
  ignoreErrors?: Array<string | RegExp>;
  /** Drop errors whose stack trace matches any of these patterns */
  denyUrls?: Array<string | RegExp>;
  /** Return null to drop an error before it is sent */
  beforeSend?: (error: Error) => Error | null;
  /** Current user id, sent as user.id on every event, log, error, and span. */
  userId?: string | (() => string | undefined);
  /** Same shape as the full SDK. Only batching delay and size apply here. */
  telemetry?: {
    traces?: { scheduledDelayMillis?: number; maxExportBatchSize?: number };
    logs?: { scheduledDelayMillis?: number; maxExportBatchSize?: number };
  };
}

export interface StradaUserIdentity {
  /** Stable application user id. */
  id: string;
  /** User email. PII, sent only through identifyUser profile events. */
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

export interface CaptureExceptionOptions {
  /** Was this error caught by user code (true) or a global handler (false)? */
  handled?: boolean;
  /** How the exception was captured, e.g. onerror or unhandledrejection */
  mechanism?: string;
  /** Extra tags attached to the error */
  tags?: Record<string, string>;
  /** Custom fingerprint override for issue grouping. */
  fingerprint?: string[];
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
  /** Session ID. Falls back to an ephemeral server id. */
  sessionId?: string;
  /** User ID. Falls back to the userId init option. */
  userId?: string;
  /** Extra span attributes to set on the pageview span. */
  attributes?: Record<string, string>;
}

export interface StartSpanOptions {
  name: string;
  attributes?: Attributes;
}

/** Same values as OTel SpanStatusCode. */
export const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 } as const;

/** Subset of the OTel Span interface, so full SDK spans fit wherever a light span is expected. */
export interface Span {
  spanContext(): { traceId: string; spanId: string; traceFlags: number };
  setAttribute(key: string, value: AttributeValue): this;
  setAttributes(attributes: Attributes): this;
  addEvent(name: string, attributes?: Attributes): this;
  setStatus(status: { code: number; message?: string }): this;
  updateName(name: string): this;
  recordException(exception: Error | string): void;
  isRecording(): boolean;
  end(): void;
}

export type DisposableSpan = Span & Disposable;

type LogMethod = (...args: unknown[]) => void;

/** Console-style logger. The full SDK logger also has OTel `emit()`, light does not. */
export interface StradaLogger {
  trace: LogMethod;
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  fatal: LogMethod;
}

type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: number }
  | { doubleValue: number }
  | { boolValue: boolean };

type OtlpKeyValue = { key: string; value: OtlpAnyValue };

type OtlpLogRecord = {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  eventName?: string;
  traceId?: string;
  spanId?: string;
  attributes: OtlpKeyValue[];
};

type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events: Array<{ timeUnixNano: string; name: string; attributes: OtlpKeyValue[] }>;
  status: { code: number; message?: string };
};

type ActiveSpan = { traceId: string; spanId: string };

/** A queued log record plus its instrumentation scope (the getLogger() name). */
type QueuedLog = { scope: string; record: OtlpLogRecord };

type LightState = {
  options: StradaOptions;
  endpoint: string;
  exporting: boolean;
  resource: OtlpKeyValue[];
  logs: QueuedLog[];
  spans: OtlpSpan[];
  inflight: Promise<Error | undefined>;
  timer: ReturnType<typeof setInterval> | undefined;
};

// OTel SeverityNumber values, inlined to avoid importing @opentelemetry/api-logs.
const SEVERITY = {
  trace: [1, "TRACE"],
  debug: [5, "DEBUG"],
  info: [9, "INFO"],
  warn: [13, "WARN"],
  error: [17, "ERROR"],
  fatal: [21, "FATAL"],
} as const;
const SPAN_KIND_INTERNAL = 1;
const MAX_QUEUE_SIZE = 2048;
const MAX_LOG_STRING_LENGTH = 16_384;

let state: LightState | undefined;
let tags: Record<string, string> = {};

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[@strada.sh/light] ${message}`);
}

function failure(message: string, cause?: unknown): Error {
  warnOnce(message);
  return new Error(message, { cause });
}

function isDevMode(): boolean {
  try {
    return Boolean((import.meta as { hot?: unknown }).hot);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Active span context
// ---------------------------------------------------------------------------

const asyncStorage: AsyncLocalStorage<ActiveSpan> | undefined = (() => {
  try {
    const hooks = globalThis.process?.getBuiltinModule?.("node:async_hooks") as
      | typeof import("node:async_hooks")
      | undefined;
    return hooks ? new hooks.AsyncLocalStorage<ActiveSpan>() : undefined;
  } catch {
    return undefined;
  }
})();
let syncActiveSpan: ActiveSpan | undefined;

function getActiveSpan(): ActiveSpan | undefined {
  return asyncStorage ? asyncStorage.getStore() : syncActiveSpan;
}

function runWithActiveSpan<T>(active: ActiveSpan, fn: () => T): T {
  if (asyncStorage) return asyncStorage.run(active, fn);
  const previous = syncActiveSpan;
  syncActiveSpan = active;
  try {
    return fn();
  } finally {
    syncActiveSpan = previous;
  }
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function randomHex(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (value) => {
    return value.toString(16).padStart(2, "0");
  }).join("");
}

function nowUnixNano(): string {
  return `${BigInt(Date.now()) * 1_000_000n}`;
}

function toAnyValue(value: AttributeValue): OtlpAnyValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (Number.isInteger(value)) return { intValue: value };
  return { doubleValue: value };
}

function toKeyValues(record: Record<string, AttributeValue | undefined>): OtlpKeyValue[] {
  return Object.entries(record).flatMap(([key, value]) => {
    if (value === undefined || value === "") return [];
    return [{ key, value: toAnyValue(value) }];
  });
}

function truncate(value: string): string {
  if (value.length <= MAX_LOG_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_LOG_STRING_LENGTH)}… [truncated ${value.length - MAX_LOG_STRING_LENGTH} chars]`;
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") return truncate(value);
  if (value instanceof Error) return truncate(value.stack || value.message);
  if (value === undefined) return "undefined";
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") return String(value);
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (_key, nested) => {
      if (typeof nested === "bigint") return nested.toString();
      if (typeof nested === "object" && nested !== null) {
        if (seen.has(nested)) return "[Circular]";
        seen.add(nested);
      }
      return nested;
    });
    return truncate(json ?? String(value));
  } catch {
    return truncate(String(value));
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** One plain object = structured log (fields become attributes). Anything else = console-style body. */
function normalizeLogInput(args: unknown[]): { body: string; attributes: Attributes } {
  const [first] = args;
  if (args.length === 1 && isPlainObject(first)) {
    const attributes: Attributes = Object.fromEntries(
      Object.entries(first).flatMap(([key, value]): Array<[string, AttributeValue]> => {
        if (value == null) return [];
        if (typeof value === "number" || typeof value === "boolean") return [[key, value]];
        return [[key, formatLogValue(value)]];
      }),
    );
    const message = attributes.message;
    return { body: typeof message === "string" ? message : formatLogValue(first), attributes };
  }
  return { body: args.map(formatLogValue).join(" "), attributes: {} };
}

function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  try {
    const message = typeof value === "object" && value !== null ? Reflect.get(value, "message") : undefined;
    return new Error(typeof message === "string" ? message : String(value));
  } catch {
    return new Error("Unknown error");
  }
}

function matchesAny(value: string, patterns: Array<string | RegExp> | undefined): boolean {
  return (patterns ?? []).some((pattern) => {
    return typeof pattern === "string" ? value.includes(pattern) : pattern.test(value);
  });
}

function currentUserId(): string | undefined {
  const userId = state?.options.userId;
  return typeof userId === "function" ? userId() : userId;
}

// ---------------------------------------------------------------------------
// Queue and export
// ---------------------------------------------------------------------------

async function post({ current, path, body }: { current: LightState; path: string; body: object }): Promise<Error | undefined> {
  try {
    const response = await fetch(`${current.endpoint}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(current.options.token ? { authorization: `Bearer ${current.options.token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) return failure(`Strada ingest ${path} responded ${response.status}`);
    return undefined;
  } catch (cause) {
    return failure(`Strada ingest ${path} request failed`, cause);
  }
}

async function send({
  current,
  logs,
  spans,
}: {
  current: LightState;
  logs: QueuedLog[];
  spans: OtlpSpan[];
}): Promise<Error | undefined> {
  const scopeNames = [...new Set(logs.map((log) => log.scope))];
  const scopeLogs = scopeNames.map((name) => {
    return {
      scope: { name },
      logRecords: logs.filter((log) => log.scope === name).map((log) => log.record),
    };
  });
  const results = await Promise.all([
    logs.length > 0
      ? post({ current, path: "/v1/logs", body: { resourceLogs: [{ resource: { attributes: current.resource }, scopeLogs }] } })
      : undefined,
    spans.length > 0
      ? post({
          current,
          path: "/v1/traces",
          body: {
            resourceSpans: [{ resource: { attributes: current.resource }, scopeSpans: [{ scope: { name: "strada" }, spans }] }],
          },
        })
      : undefined,
  ]);
  return results.find((result) => {
    return result instanceof Error;
  });
}

/** Returns the live state only when exporting, so callers can skip building records. */
function exportingState(operation: string): LightState | undefined {
  if (!state) {
    warnOnce(`${operation} called before initStrada(). Nothing was sent.`);
    return undefined;
  }
  return state.exporting ? state : undefined;
}

function scheduleFlush(current: LightState): void {
  if (!current.timer) {
    const delay = Math.min(
      current.options.telemetry?.logs?.scheduledDelayMillis ?? 5000,
      current.options.telemetry?.traces?.scheduledDelayMillis ?? 5000,
    );
    current.timer = setInterval(() => {
      void flush();
    }, delay);
    // Never keep a CLI or daemon alive just to send telemetry.
    if (typeof current.timer === "object" && typeof current.timer.unref === "function") {
      current.timer.unref();
    }
  }
  const logsFull = current.logs.length >= (current.options.telemetry?.logs?.maxExportBatchSize ?? 512);
  const spansFull = current.spans.length >= (current.options.telemetry?.traces?.maxExportBatchSize ?? 512);
  if (logsFull || spansFull) void flush();
}

function emitLog({
  operation,
  scope = "strada",
  body,
  severity,
  eventName,
  attributes,
}: {
  operation: string;
  scope?: string;
  body: string;
  severity: keyof typeof SEVERITY;
  eventName?: string;
  attributes: Record<string, AttributeValue | undefined>;
}): Error | undefined {
  const current = exportingState(operation);
  if (!current) return undefined;
  if (current.logs.length >= MAX_QUEUE_SIZE) return failure("Log queue full, dropping telemetry");
  const [severityNumber, severityText] = SEVERITY[severity];
  const active = getActiveSpan();
  const time = nowUnixNano();
  current.logs.push({ scope, record: {
    timeUnixNano: time,
    observedTimeUnixNano: time,
    severityNumber,
    severityText,
    body: { stringValue: body },
    ...(eventName ? { eventName } : {}),
    ...(active ? { traceId: active.traceId, spanId: active.spanId } : {}),
    attributes: toKeyValues({ [ATTR["user.id"]]: currentUserId(), ...attributes }),
  } });
  scheduleFlush(current);
  return undefined;
}

function emitSpan(span: OtlpSpan): void {
  const current = exportingState("span.end()");
  if (!current) return;
  if (current.spans.length >= MAX_QUEUE_SIZE) {
    warnOnce("Span queue full, dropping telemetry");
    return;
  }
  current.spans.push(span);
  scheduleFlush(current);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initStrada(options: StradaOptions): Error | undefined {
  try {
    if (state) {
      warnOnce("initStrada() was already called. Ignoring duplicate init.");
      return undefined;
    }
    const endpoint = options.endpoint?.trim()
      ? options.endpoint.replace(/\/+$/, "").toLowerCase()
      : options.projectId?.trim()
        ? `https://${options.projectId}-ingest.strada.sh`.toLowerCase()
        : "";
    if (!endpoint && options.enabled !== false) {
      warnOnce("initStrada() called without a projectId. Telemetry is disabled and all SDK calls are no-ops.");
    }
    state = {
      options,
      endpoint,
      exporting: Boolean(endpoint) && (options.enabled ?? !isDevMode()),
      resource: toKeyValues({
        [ATTR["service.name"]]: options.service,
        [ATTR["service.version"]]: options.version,
        [ATTR["deployment.environment.name"]]: options.environment,
        [ATTR["vcs.ref.head.revision"]]: options.releaseCommit,
        [ATTR["vcs.ref.head.name"]]: options.releaseBranch,
        [ATTR["deployment.id"]]: options.deploymentId ?? options.releaseCommit,
      }),
      logs: [],
      spans: [],
      inflight: Promise.resolve(undefined),
      timer: undefined,
    };
    return undefined;
  } catch (cause) {
    return failure("initStrada() failed", cause);
  }
}

/** Product analytics event. Properties are stored as `custom.*` attributes. */
export function track(name: string, properties?: Attributes): Error | undefined {
  try {
    const custom = Object.fromEntries(
      Object.entries(properties ?? {}).map(([key, value]) => {
        return [`custom.${key}`, value];
      }),
    );
    return emitLog({
      operation: "track()",
      body: name,
      severity: "info",
      eventName: name,
      attributes: { [ATTR["event.name"]]: name, ...custom },
    });
  } catch (cause) {
    return failure("track() failed", cause);
  }
}

/** Full profile snapshot for `otel_users`. Call from trusted code with every field you want to keep. */
export function identifyUser(user: StradaUserIdentity): Error | undefined {
  try {
    const name = ATTR["strada.user.identify"];
    return emitLog({
      operation: "identifyUser()",
      body: name,
      severity: "info",
      eventName: name,
      attributes: {
        [ATTR["event.name"]]: name,
        [ATTR["user.id"]]: user.id,
        [ATTR["user.email"]]: user.email,
        [ATTR["user.name"]]: user.name,
        [ATTR["user.full_name"]]: user.fullName,
        [ATTR["user.hash"]]: user.hash,
        [ATTR["user.image"]]: user.image,
        [ATTR["organization.id"]]: user.organizationId,
        [ATTR["organization.name"]]: user.organizationName,
        ...Object.fromEntries(
          Object.entries(user.attributes ?? {}).map(([key, value]) => {
            return [`strada.user.attributes.${key}`, value];
          }),
        ),
      },
    });
  } catch (cause) {
    return failure("identifyUser() failed", cause);
  }
}

/** Tags merged into every captureException() call. */
export function setTags(next: Record<string, string>): void {
  tags = { ...tags, ...next };
}

/** Report an error as an issue. Applies KnownError, ignoreErrors, denyUrls, and beforeSend. */
export function captureException(error: unknown, opts?: CaptureExceptionOptions): Error | undefined {
  try {
    const normalized = normalizeError(error);
    const options = state?.options;
    if (normalized.name === "KnownError" || normalized.constructor?.name === "KnownError") return undefined;
    if (matchesAny(normalized.message || "", options?.ignoreErrors)) return undefined;
    if (matchesAny(normalized.stack || "", options?.denyUrls)) return undefined;
    const prepared = (() => {
      if (!options?.beforeSend) return normalized;
      try {
        return options.beforeSend(normalized);
      } catch (thrown) {
        warnOnce(`beforeSend threw, sending the original error instead: ${normalizeError(thrown).message}`);
        return normalized;
      }
    })();
    if (!prepared) return undefined;

    const fingerprintValue = Reflect.get(prepared, "fingerprint");
    const fingerprint = opts?.fingerprint ?? (Array.isArray(fingerprintValue) ? fingerprintValue : undefined);
    return emitLog({
      operation: "captureException()",
      body: prepared.message,
      severity: "error",
      eventName: "exception",
      attributes: {
        [ATTR["exception.type"]]: prepared.name || "Error",
        [ATTR["exception.message"]]: prepared.message || "",
        [ATTR["exception.stacktrace"]]: prepared.stack ?? "",
        [ATTR["exception.mechanism.type"]]: opts?.mechanism ?? "generic",
        [ATTR["exception.mechanism.handled"]]: String(opts?.handled ?? true),
        [ATTR["exception.fingerprint"]]: fingerprint ? JSON.stringify(fingerprint) : undefined,
        ...tags,
        ...opts?.tags,
      },
    });
  } catch (cause) {
    return failure("captureException() failed", cause);
  }
}

/** Console-style logger that sends to `otel_logs`. Not exception capture: use captureException() for issues. */
export function getLogger(name = "strada"): StradaLogger {
  const method = (severity: keyof typeof SEVERITY): LogMethod => {
    return (...args) => {
      try {
        const { body, attributes } = normalizeLogInput(args);
        void emitLog({ operation: `logger.${severity}()`, scope: name, body, severity, attributes });
      } catch (cause) {
        void failure(`logger.${severity}() failed`, cause);
      }
    };
  };
  return {
    trace: method("trace"),
    debug: method("debug"),
    info: method("info"),
    warn: method("warn"),
    error: method("error"),
    fatal: method("fatal"),
  };
}

function createSpan(options: StartSpanOptions): DisposableSpan {
  const parent = getActiveSpan();
  const traceId = parent?.traceId ?? randomHex(16);
  const spanId = randomHex(8);
  const startTimeUnixNano = nowUnixNano();
  let name = options.name;
  let ended = false;
  let status: { code: number; message?: string } = { code: SpanStatusCode.UNSET };
  const attributes: Record<string, AttributeValue | undefined> = {
    [ATTR["user.id"]]: currentUserId(),
    ...options.attributes,
  };
  const events: OtlpSpan["events"] = [];

  const span: DisposableSpan = {
    spanContext() {
      return { traceId, spanId, traceFlags: 1 };
    },
    setAttribute(key, value) {
      attributes[key] = value;
      return span;
    },
    setAttributes(next) {
      Object.assign(attributes, next);
      return span;
    },
    addEvent(eventName, eventAttributes) {
      events.push({ timeUnixNano: nowUnixNano(), name: eventName, attributes: toKeyValues(eventAttributes ?? {}) });
      return span;
    },
    setStatus(next) {
      status = next;
      return span;
    },
    updateName(next) {
      name = next;
      return span;
    },
    recordException(exception) {
      const error = normalizeError(exception);
      span.addEvent("exception", {
        [ATTR["exception.type"]]: error.name || "Error",
        [ATTR["exception.message"]]: error.message || "",
        [ATTR["exception.stacktrace"]]: error.stack ?? "",
      });
    },
    isRecording() {
      return !ended;
    },
    end() {
      if (ended) return;
      ended = true;
      emitSpan({
        traceId,
        spanId,
        ...(parent ? { parentSpanId: parent.spanId } : {}),
        name,
        kind: SPAN_KIND_INTERNAL,
        startTimeUnixNano,
        endTimeUnixNano: nowUnixNano(),
        attributes: toKeyValues(attributes),
        events,
        status,
      });
    },
    [Symbol.dispose]() {
      span.end();
    },
  };
  return span;
}

/** Create a detached span. Call `span.end()` or use `using`. It does not parent later spans. */
export function startInactiveSpan(options: StartSpanOptions): DisposableSpan {
  return createSpan(options);
}

/**
 * Run `callback` inside an active span that auto-ends. Spans, logs, events,
 * and errors created inside are parented to it. A thrown error is recorded on
 * the span and rethrown.
 */
export function startSpan<T>(options: StartSpanOptions, callback: (span: Span) => T): T {
  const span = createSpan(options);
  const onError = (error: unknown) => {
    span.recordException(normalizeError(error));
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  };
  const result = (() => {
    try {
      return runWithActiveSpan(span.spanContext(), () => {
        return callback(span);
      });
    } catch (error) {
      onError(error);
      throw error;
    }
  })();
  if (result instanceof Promise) {
    return result.then(
      (value) => {
        span.end();
        return value;
      },
      (error) => {
        onError(error);
        throw error;
      },
    ) as T;
  }
  span.end();
  return result;
}

/** Server-side pageview span. Feeds the same analytics views as browser pageviews. */
export function trackPageview(opts: TrackPageviewOptions): Error | undefined {
  try {
    const url = (() => {
      try {
        return opts.url ? new URL(opts.url) : undefined;
      } catch {
        return undefined;
      }
    })();
    const span = createSpan({
      name: "pageview",
      attributes: {
        ...opts.attributes,
        [ATTR["url.path"]]: opts.path || url?.pathname || "/",
        [ATTR["pageview.source"]]: "server",
        // Analytics views require a non-empty session.id.
        [ATTR["session.id"]]: opts.sessionId ?? `server:${crypto.randomUUID()}`,
        ...(url ? { [ATTR["url.full"]]: url.href } : {}),
        ...(opts.query || url?.search ? { [ATTR["url.query"]]: opts.query || url?.search || "" } : {}),
        ...(opts.referrer ? { [ATTR["http.request.header.referer"]]: opts.referrer } : {}),
        ...(opts.userId ? { [ATTR["user.id"]]: opts.userId } : {}),
      },
    });
    span.end();
    return undefined;
  } catch (cause) {
    return failure("trackPageview() failed", cause);
  }
}

export function flush(): Promise<Error | undefined> {
  const current = state;
  if (!current) return Promise.resolve(undefined);
  if (current.logs.length === 0 && current.spans.length === 0) return current.inflight;
  const logs = current.logs;
  const spans = current.spans;
  current.logs = [];
  current.spans = [];
  // Chain sends so flush() resolves only after every earlier batch is done.
  current.inflight = current.inflight.then(() => {
    return send({ current, logs, spans });
  });
  return current.inflight;
}

export async function shutdown(): Promise<Error | undefined> {
  const current = state;
  if (!current) return undefined;
  clearInterval(current.timer);
  const error = await flush();
  state = undefined;
  return error;
}
