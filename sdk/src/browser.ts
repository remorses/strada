/**
 * Browser runtime entry for @strada.sh/sdk.
 *
 * Wraps @opentelemetry/sdk-trace-web and sdk-logs with Strada conventions:
 * web auto-instrumentation, global error handlers, browser junk filtering,
 * session management, pageview spans, custom event tracking (track API),
 * and context injection into every span and log record.
 *
 * Everything flows through standard OTel OTLP HTTP/JSON. No custom transport.
 *
 * Analytics model (from docs/browser-analytics.md):
 * - Pageviews = spans in otel_traces (SpanName = 'pageview')
 * - Custom events = log records in otel_logs (event.name attribute)
 * - Session = one TraceId per tab, stored in sessionStorage
 * - Context (session.id, url.*, user.id) injected into every span and log
 */

import { trace, context } from "@opentelemetry/api";
import type { Span as ApiSpan } from "@opentelemetry/api";
import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { resourceFromAttributes, detectResources } from "@opentelemetry/resources";
import { logs } from "@opentelemetry/api-logs";
import type { Logger } from "@opentelemetry/api-logs";

import {
  type StradaOptions,
  type CaptureExceptionOptions,
  type UserContext,
  normalizeError,
  shouldIgnoreError,
  errorToAttributes,
  setUser,
  setTags,
  resetContext,
  resolveUserId,
  ERROR_SEVERITY,
  ERROR_SEVERITY_TEXT,
  INFO_SEVERITY,
  INFO_SEVERITY_TEXT,
} from "./shared.ts";

// Re-export shared types, helpers, and OTel primitives so users only need one import
export {
  type StradaOptions,
  type CaptureExceptionOptions,
  type UserContext,
  setUser,
  setTags,
  // OTel API re-exports
  trace,
  context,
  metrics,
  propagation,
  diag,
  SpanStatusCode,
  SpanKind,
  SeverityNumber,
  logs,
  type Tracer,
  type Span,
  type SpanContext,
  type SpanOptions,
  type SpanAttributes,
  type Logger,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

const SESSION_STORAGE_KEY = "strada.session_id";

function getOrCreateSessionId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem(SESSION_STORAGE_KEY, id);
    return id;
  } catch {
    // sessionStorage unavailable (e.g. sandboxed iframe, SSR).
    // Fall back to in-memory ID that won't survive page refresh.
    return crypto.randomUUID();
  }
}

// ---------------------------------------------------------------------------
// Filtering log processor
// ---------------------------------------------------------------------------

/**
 * Wraps another LogRecordProcessor and drops log records that match
 * browser noise patterns (Script error, ResizeObserver, extensions).
 */
class FilteringLogProcessor implements LogRecordProcessor {
  constructor(private readonly inner: LogRecordProcessor) {}

  onEmit(...args: Parameters<LogRecordProcessor["onEmit"]>): void {
    const record = args[0];
    const message = String(record.attributes?.["exception.message"] ?? "");
    const stack = String(record.attributes?.["exception.stacktrace"] ?? "");

    if (message === "Script error." || message === "Script error") return;
    if (message.includes("ResizeObserver loop limit exceeded")) return;
    if (message.includes("ResizeObserver loop completed with undelivered notifications")) return;
    if (stack.includes("chrome-extension://")) return;
    if (stack.includes("moz-extension://")) return;
    if (stack.includes("safari-extension://")) return;

    this.inner.onEmit(...args);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Context-injecting span processor
// ---------------------------------------------------------------------------

/**
 * Injects Strada analytics context into every span: session.id, url.*,
 * user.id, and referrer. This ensures all browser spans (auto-instrumented
 * fetch, XHR, document load, user interaction) carry analytics context
 * without the app developer doing anything.
 */
class StradaSpanProcessor implements SpanProcessor {
  constructor(
    private readonly getSessionId: () => string,
    private readonly getUserId: () => string | undefined,
  ) {}

  onStart(span: Span): void {
    const sessionId = this.getSessionId();
    span.setAttribute("session.id", sessionId);

    // Current page URL info
    if (typeof window !== "undefined") {
      span.setAttribute("url.path", window.location.pathname);
      span.setAttribute("url.query", window.location.search);
      span.setAttribute("url.full", window.location.href);
      if (document.referrer) {
        span.setAttribute("http.request.header.referer", document.referrer);
      }
    }

    const userId = this.getUserId();
    if (userId) {
      span.setAttribute("user.id", userId);
    }
  }

  onEnd(): void {
    // no-op
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Context-injecting log processor
// ---------------------------------------------------------------------------

/**
 * Wraps another LogRecordProcessor and injects session.id, url.*, user.id
 * into every log record. This ensures custom events (track) and error logs
 * carry analytics context automatically.
 */
class ContextLogProcessor implements LogRecordProcessor {
  constructor(
    private readonly inner: LogRecordProcessor,
    private readonly getSessionId: () => string,
    private readonly getUserId: () => string | undefined,
  ) {}

  onEmit(...args: Parameters<LogRecordProcessor["onEmit"]>): void {
    const record = args[0];

    // Inject analytics context into the log record
    record.setAttribute("session.id", this.getSessionId());
    if (typeof window !== "undefined") {
      record.setAttribute("url.path", window.location.pathname);
      record.setAttribute("url.full", window.location.href);
    }
    const userId = this.getUserId();
    if (userId) {
      record.setAttribute("user.id", userId);
    }

    this.inner.onEmit(...args);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _tracerProvider: WebTracerProvider | undefined;
let _loggerProvider: LoggerProvider | undefined;
let _logger: Logger | undefined;
let _options: StradaOptions | undefined;
let _sessionId: string | undefined;
let _currentPageviewSpan: ApiSpan | undefined;
let _errorListener: ((event: ErrorEvent) => void) | undefined;
let _rejectionListener: ((event: PromiseRejectionEvent) => void) | undefined;
let _visibilityListener: (() => void) | undefined;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Initialize Strada for the browser. Call this once at app startup,
 * before rendering your app.
 *
 * Sets up:
 * - Session ID (sessionStorage UUID, per-tab)
 * - OTel WebTracerProvider with context-injecting span processor
 * - OTel LoggerProvider with filtering + context injection
 * - Web auto-instrumentation (fetch, XHR, document load, user interaction)
 * - Global window.error / unhandledrejection handlers
 * - First pageview span
 * - track() and identify() APIs
 */
export function initStrada(options: StradaOptions): void {
  if (_tracerProvider) {
    console.warn("[@strada.sh/sdk] initStrada() was already called. Ignoring duplicate init.");
    return;
  }

  _options = options;
  _sessionId = getOrCreateSessionId();

  const getUserId = () => resolveUserId(_options);

  // Build resource with Strada attributes + browser detector
  let resource = resourceFromAttributes({
    "service.name": options.service,
    ...(options.version ? { "service.version": options.version } : {}),
    ...(options.environment ? { "deployment.environment.name": options.environment } : {}),
  });

  // Detect browser attributes (platform, brands, mobile, language, user_agent)
  // using the OTel browser detector. This is synchronous since navigator APIs
  // are available immediately in the browser.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@opentelemetry/opentelemetry-browser-detector");
    if (mod && mod.browserDetector) {
      const detected = detectResources({ detectors: [mod.browserDetector] });
      resource = resource.merge(detected);
    }
  } catch {
    // Browser detector not installed, that's fine.
    // Users can install @opentelemetry/opentelemetry-browser-detector to
    // get automatic browser.platform, browser.brands, browser.mobile,
    // browser.language, and user_agent.original resource attributes.
    if (options.debug) {
      console.log("[@strada.sh/sdk] @opentelemetry/opentelemetry-browser-detector not found, skipping");
    }
  }

  const endpoint = options.endpoint.replace(/\/+$/, "");

  // Tracer provider with context-injecting processor
  _tracerProvider = new WebTracerProvider({
    resource,
    spanProcessors: [
      new StradaSpanProcessor(() => _sessionId!, getUserId),
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      ),
    ],
  });
  _tracerProvider.register();

  // Logger provider: context injection -> filtering -> batch export
  const logExporter = new OTLPLogExporter({ url: `${endpoint}/v1/logs` });
  _loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new ContextLogProcessor(
        new FilteringLogProcessor(
          new BatchLogRecordProcessor(logExporter),
        ),
        () => _sessionId!,
        getUserId,
      ),
    ],
  });
  logs.setGlobalLoggerProvider(_loggerProvider);
  _logger = _loggerProvider.getLogger("strada-web");

  // Try to load web auto-instrumentations (optional peer dep)
  import("@opentelemetry/auto-instrumentations-web")
    .then((mod) => {
      if (typeof mod.getWebAutoInstrumentations === "function") {
        registerInstrumentations({
          instrumentations: mod.getWebAutoInstrumentations(),
        });
      }
    })
    .catch(() => {
      if (options.debug) {
        console.log("[@strada.sh/sdk] @opentelemetry/auto-instrumentations-web not found, skipping");
      }
    });

  // Start first pageview span
  startPageSpan(window.location.pathname);

  // Global error handlers
  _errorListener = (event: ErrorEvent) => {
    const error = event.error;
    if (error instanceof Error) {
      captureException(error, { handled: false });
    } else if (typeof event.message === "string" && event.message) {
      captureException(new Error(event.message), { handled: false });
    }
  };

  _rejectionListener = (event: PromiseRejectionEvent) => {
    const error = normalizeError(event.reason);
    captureException(error, { handled: false });
  };

  window.addEventListener("error", _errorListener);
  window.addEventListener("unhandledrejection", _rejectionListener);

  // End pageview span on tab hide/close
  _visibilityListener = () => {
    if (document.visibilityState === "hidden") {
      endCurrentPageSpan();
    }
  };
  document.addEventListener("visibilitychange", _visibilityListener);
}

// ---------------------------------------------------------------------------
// Pageview span lifecycle
// ---------------------------------------------------------------------------

/**
 * Start a new pageview span. Ends the previous one if still active.
 * Called automatically on initStrada() for the initial page, and by
 * SPA router plugins on navigation.
 */
export function startPageSpan(path?: string): void {
  endCurrentPageSpan();

  const tracer = trace.getTracer("strada-web");
  _currentPageviewSpan = tracer.startSpan("pageview", {
    attributes: {
      "session.id": _sessionId ?? "",
      "url.path": path ?? window.location.pathname,
      "url.query": window.location.search,
      "url.full": window.location.href,
      ...(document.referrer ? { "http.request.header.referer": document.referrer } : {}),
    },
  });
}

/**
 * End the current pageview span. Called automatically on visibilitychange
 * (hidden) and before starting a new pageview.
 */
export function endCurrentPageSpan(): void {
  if (_currentPageviewSpan) {
    _currentPageviewSpan.end();
    _currentPageviewSpan = undefined;
  }
}

// ---------------------------------------------------------------------------
// Custom event tracking (track API)
// ---------------------------------------------------------------------------

/**
 * Track a custom analytics event. Emits an OTel log record with the event
 * name and custom properties. The log record is automatically correlated
 * to the active pageview span via TraceId/SpanId.
 *
 * Custom properties are prefixed with "custom." to isolate them from
 * standard OTel attributes.
 *
 * @example
 * ```ts
 * track('button_click')
 * track('form_submit', { form: 'signup', plan: 'pro' })
 * ```
 */
export function track(
  name: string,
  properties?: Record<string, string | number | boolean>,
): void {
  if (!_logger) {
    console.warn("[@strada.sh/sdk] track() called before initStrada(). Event was not sent.");
    return;
  }

  const attributes: Record<string, string | number | boolean> = {
    "event.name": name,
  };

  // Add custom properties with custom.* prefix
  if (properties) {
    for (const [k, v] of Object.entries(properties)) {
      attributes[`custom.${k}`] = v;
    }
  }

  // Emit within the context of the current pageview span so TraceId/SpanId
  // are automatically set on the log record by OTel context propagation
  const ctx = _currentPageviewSpan
    ? trace.setSpan(context.active(), _currentPageviewSpan)
    : context.active();

  _logger.emit({
    severityNumber: INFO_SEVERITY,
    severityText: INFO_SEVERITY_TEXT,
    body: name,
    attributes,
    context: ctx,
  });
}

// ---------------------------------------------------------------------------
// Error capture
// ---------------------------------------------------------------------------

/**
 * Capture an exception and send it to Strada as an OTel log record.
 * The ingest worker extracts exception.* attributes and writes a
 * denormalized row to otel_errors for issue grouping.
 */
export function captureException(
  error: unknown,
  opts?: CaptureExceptionOptions,
): void {
  const normalized = normalizeError(error);

  if (_options && shouldIgnoreError(normalized, _options)) return;
  if (_options?.beforeSend) {
    const result = _options.beforeSend(normalized);
    if (result === null) return;
  }

  const attributes = errorToAttributes(normalized, opts);

  if (_logger) {
    // Emit within pageview span context for trace correlation
    const ctx = _currentPageviewSpan
      ? trace.setSpan(context.active(), _currentPageviewSpan)
      : context.active();

    _logger.emit({
      severityNumber: ERROR_SEVERITY,
      severityText: ERROR_SEVERITY_TEXT,
      body: normalized.message,
      attributes,
      context: ctx,
    });
  } else {
    console.warn("[@strada.sh/sdk] captureException called before initStrada(). Error was not sent.");
  }
}

// ---------------------------------------------------------------------------
// Flush / Shutdown
// ---------------------------------------------------------------------------

/**
 * Flush all buffered telemetry (logs, traces).
 */
export async function flush(): Promise<void> {
  await _loggerProvider?.forceFlush();
  await _tracerProvider?.forceFlush();
}

/**
 * Shut down the SDK, flush remaining telemetry, and remove global handlers.
 */
export async function shutdown(): Promise<void> {
  if (_errorListener) {
    window.removeEventListener("error", _errorListener);
    _errorListener = undefined;
  }
  if (_rejectionListener) {
    window.removeEventListener("unhandledrejection", _rejectionListener);
    _rejectionListener = undefined;
  }
  if (_visibilityListener) {
    document.removeEventListener("visibilitychange", _visibilityListener);
    _visibilityListener = undefined;
  }
  endCurrentPageSpan();
  await _tracerProvider?.shutdown();
  await _loggerProvider?.shutdown();
  _tracerProvider = undefined;
  _loggerProvider = undefined;
  _logger = undefined;
  _options = undefined;
  _sessionId = undefined;
  resetContext();
}
