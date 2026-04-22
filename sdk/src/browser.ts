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
 * - Session = one session.id per tab, stored in sessionStorage
 * - Context (session.id, url.*, user.id) injected into every span and log
 */

import { trace, context, propagation } from "@opentelemetry/api";
import type { Context as OtelContext, ContextManager, Span as ApiSpan } from "@opentelemetry/api";
import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { StackContextManager, WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  type BatchLogRecordProcessorBrowserConfig,
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { logs } from "@opentelemetry/api-logs";
import type { Logger } from "@opentelemetry/api-logs";

import {
  type BatchSpanProcessorBrowserConfig,
  type StradaOptions,
  type CaptureExceptionOptions,
  type UserContext,
  applyBeforeSend,
  normalizeError,
  shouldIgnoreError,
  errorToAttributes,
  setUser,
  setTags,
  resetContext,
  resolveUserId,
  ATTR,
  createStradaBaggage,
  BAGGAGE_SESSION_ID,
  BAGGAGE_USER_ID,
  ERROR_SEVERITY,
  ERROR_SEVERITY_TEXT,
  INFO_SEVERITY,
  INFO_SEVERITY_TEXT,
} from "./shared.ts";

// Re-export shared types, helpers, and OTel primitives so users only need one import
export {
  type StradaOptions,
  type CaptureExceptionOptions,
  type StradaTelemetryOptions,
  type UserContext,
  setUser,
  setTags,
  type BatchSpanProcessorBrowserConfig,
  type BatchLogRecordProcessorBrowserConfig,
  type PeriodicExportingMetricReaderOptions,
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
    const message = String(record.attributes?.[ATTR.EXCEPTION_MESSAGE] ?? "");
    const stack = String(record.attributes?.[ATTR.EXCEPTION_STACKTRACE] ?? "");

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
    span.setAttribute(ATTR.SESSION_ID, sessionId);

    // Current page URL info
    if (typeof window !== "undefined") {
      for (const [key, value] of Object.entries(getPageAttributes())) {
        if (value) {
          span.setAttribute(key, value);
        }
      }
    }

    const userId = this.getUserId();
    if (userId) {
      span.setAttribute(ATTR.USER_ID, userId);
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
    record.setAttribute(ATTR.SESSION_ID, this.getSessionId());
    if (typeof window !== "undefined") {
      record.setAttribute(ATTR.URL_PATH, window.location.pathname);
      record.setAttribute(ATTR.URL_FULL, window.location.href);
    }
    const userId = this.getUserId();
    if (userId) {
      record.setAttribute(ATTR.USER_ID, userId);
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
let _navigateListener: ((event: NavigateEvent) => void) | undefined;

function getPageAttributes(
  url: URL = new URL(window.location.href),
  referrer: string = document.referrer,
): Record<string, string> {
  return {
    [ATTR.URL_PATH]: url.pathname,
    [ATTR.URL_QUERY]: url.search,
    [ATTR.URL_FULL]: url.href,
    ...(referrer ? { [ATTR.REFERER]: referrer } : {}),
  };
}

export function getBrowserWorkContext(
  activeContext: OtelContext,
  pageviewSpan: ApiSpan | undefined,
): OtelContext {
  if (!pageviewSpan || trace.getSpan(activeContext)) {
    return activeContext;
  }

  return trace.setSpan(activeContext, pageviewSpan);
}

class PageviewContextManager implements ContextManager {
  constructor(
    private readonly inner: ContextManager,
    private readonly getPageviewSpan: () => ApiSpan | undefined,
    private readonly getBaggage: () => import("@opentelemetry/api").Baggage,
  ) {}

  active(): OtelContext {
    let ctx = getBrowserWorkContext(this.inner.active(), this.getPageviewSpan());
    // Always inject current baggage (session.id, user.id) so the
    // W3CBaggagePropagator includes them in outgoing request headers.
    ctx = propagation.setBaggage(ctx, this.getBaggage());
    return ctx;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    activeContext: OtelContext,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.inner.with(activeContext, fn, thisArg, ...args);
  }

  bind<T>(activeContext: OtelContext, target: T): T {
    return this.inner.bind(activeContext, target);
  }

  enable(): this {
    this.inner.enable();
    return this;
  }

  disable(): this {
    this.inner.disable();
    return this;
  }
}

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

  // Build resource with Strada attributes + browser detection.
  // Browser attributes are detected inline (navigator APIs are synchronous)
  // instead of requiring an external package.
  const browserAttrs: Record<string, string | boolean | string[]> = {};
  if (typeof navigator !== "undefined") {
    const uaData = Reflect.get(navigator, "userAgentData");
    if (uaData) {
      const platform = Reflect.get(uaData, "platform");
      const brands = Reflect.get(uaData, "brands");
      const mobile = Reflect.get(uaData, "mobile");

      if (typeof platform === "string") {
        browserAttrs[ATTR.BROWSER_PLATFORM] = platform;
      }
      if (Array.isArray(brands)) {
        const normalizedBrands = brands
          .map((brand) => {
            const name = Reflect.get(brand, "brand");
            const version = Reflect.get(brand, "version");
            if (typeof name !== "string" || typeof version !== "string") {
              return undefined;
            }

            return `${name} ${version}`;
          })
          .filter((brand): brand is string => Boolean(brand));
        if (normalizedBrands.length > 0) {
          browserAttrs[ATTR.BROWSER_BRANDS] = normalizedBrands;
        }
      }
      if (typeof mobile === "boolean") {
        browserAttrs[ATTR.BROWSER_MOBILE] = mobile;
      }
    }
    if (navigator.userAgent) {
      browserAttrs[ATTR.USER_AGENT_ORIGINAL] = navigator.userAgent;
    }
    if (navigator.language) {
      browserAttrs[ATTR.BROWSER_LANGUAGE] = navigator.language;
    }
  }

  const resource = resourceFromAttributes({
    [ATTR.SERVICE_NAME]: options.service,
    ...(options.version ? { [ATTR.SERVICE_VERSION]: options.version } : {}),
    ...(options.environment ? { [ATTR.DEPLOYMENT_ENVIRONMENT_NAME]: options.environment } : {}),
    ...browserAttrs,
  });

  const endpoint = options.endpoint.replace(/\/+$/, "");

  // Tracer provider with context-injecting processor
  _tracerProvider = new WebTracerProvider({
    resource,
    spanProcessors: [
      new StradaSpanProcessor(() => _sessionId!, getUserId),
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
        options.telemetry?.traces,
      ),
    ],
  });
  // Register composite propagator for both trace context (traceparent) and
  // baggage (session.id, user.id) so both headers are injected on every
  // outgoing fetch/XHR request to the backend.
  _tracerProvider.register({
    contextManager: new PageviewContextManager(
      new StackContextManager(),
      () => _currentPageviewSpan,
      () => createStradaBaggage(_sessionId!, getUserId()),
    ),
    propagator: new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    }),
  });

  // Logger provider: context injection -> filtering -> batch export
  const logExporter = new OTLPLogExporter({ url: `${endpoint}/v1/logs` });
  _loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new ContextLogProcessor(
        new FilteringLogProcessor(
          new BatchLogRecordProcessor(
            logExporter,
            options.telemetry?.logs,
          ),
        ),
        () => _sessionId!,
        getUserId,
      ),
    ],
  });
  logs.setGlobalLoggerProvider(_loggerProvider);
  _logger = _loggerProvider.getLogger("strada-web");

  // Try to load web auto-instrumentations (optional peer dep).
  // Unlike Node, we keep the literal specifier here so bundlers can resolve
  // and inline it. Browsers can't resolve bare specifiers at runtime, so
  // the non-static trick used in node.ts would silently break this.
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
  startPageSpan();

  // Global error handlers
  _errorListener = (event: ErrorEvent) => {
    const error = event.error;
    if (error instanceof Error) {
      captureException(error, { handled: false, mechanism: "onerror" });
    } else if (typeof event.message === "string" && event.message) {
      captureException(new Error(event.message), {
        handled: false,
        mechanism: "onerror",
      });
    }
  };

  _rejectionListener = (event: PromiseRejectionEvent) => {
    const error = normalizeError(event.reason);
    captureException(error, {
      handled: false,
      mechanism: "unhandledrejection",
    });
  };

  window.addEventListener("error", _errorListener);
  window.addEventListener("unhandledrejection", _rejectionListener);

  // End pageview span on tab hide/close
  _visibilityListener = () => {
    if (document.visibilityState === "hidden") {
      endCurrentPageSpan();
      return;
    }

    if (document.visibilityState === "visible" && !_currentPageviewSpan) {
      startPageSpan();
    }
  };
  document.addEventListener("visibilitychange", _visibilityListener);

  // SPA navigation detection via the Navigation API.
  // Fires on every client-side navigation (pushState, replaceState, back/forward)
  // regardless of framework (Next.js, React Router, Vue Router, etc.).
  // Baseline across Chrome, Edge, Firefox, Safari since Jan 2026.
  if (typeof navigation !== "undefined") {
    _navigateListener = (event: NavigateEvent) => {
      // Skip cross-origin navigations, downloads, form submissions
      if (!event.canIntercept) return;
      // Skip reloads (same page, no URL change)
      if (event.navigationType === "reload") return;

      const dest = new URL(event.destination.url);
      const currentPath = window.location.pathname + window.location.search;
      const newPath = dest.pathname + dest.search;
      // Skip if path+query didn't actually change (e.g. hash-only change)
      if (newPath === currentPath) return;

      endCurrentPageSpan();
      startPageSpan(dest, {
        [ATTR.NAVIGATION_TYPE]: event.navigationType, // "push" | "replace" | "traverse"
        [ATTR.NAVIGATION_USER_INITIATED]: event.userInitiated,
      }, window.location.href);
    };
    navigation.addEventListener("navigate", _navigateListener);
  }
}

// ---------------------------------------------------------------------------
// Pageview span lifecycle
// ---------------------------------------------------------------------------

/**
 * Start a new pageview span. Ends the previous one if still active.
 * Called automatically on initStrada() for the initial page, and on
 * SPA navigations detected via the Navigation API.
 *
 * @param url - Override URL (defaults to window.location.href)
 * @param extraAttributes - Additional attributes for the span (e.g. navigation.type)
 */
export function startPageSpan(
  url: string | URL = window.location.href,
  extraAttributes?: Record<string, string | boolean>,
  referrer?: string,
): void {
  endCurrentPageSpan();

  const pageUrl = typeof url === "string" ? new URL(url, window.location.href) : url;
  const tracer = trace.getTracer("strada-web");
  _currentPageviewSpan = tracer.startSpan("pageview", {
    attributes: {
      [ATTR.SESSION_ID]: _sessionId ?? "",
      ...getPageAttributes(pageUrl, referrer),
      ...extraAttributes,
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
    [ATTR.EVENT_NAME]: name,
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
    eventName: name,
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
  const prepared = applyBeforeSend(normalized, _options?.beforeSend);
  if (prepared === null) return;

  const attributes = errorToAttributes(prepared, opts);

  if (_logger) {
    // Emit within pageview span context for trace correlation
    const ctx = _currentPageviewSpan
      ? trace.setSpan(context.active(), _currentPageviewSpan)
      : context.active();

    _logger.emit({
      eventName: "exception",
      severityNumber: ERROR_SEVERITY,
      severityText: ERROR_SEVERITY_TEXT,
      body: prepared.message,
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
  if (_navigateListener && typeof navigation !== "undefined") {
    navigation.removeEventListener("navigate", _navigateListener);
    _navigateListener = undefined;
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
