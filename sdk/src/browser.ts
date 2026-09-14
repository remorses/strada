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
 * Analytics model (from website/src/docs/browser-analytics.mdx):
 * - Pageviews = spans in otel_traces (SpanName = 'pageview')
 * - Custom events = log records in otel_logs (event.name attribute)
 * - Session = one session.id per tab, stored in sessionStorage
 * - Visitor = one visitor.id per browser, cookie strada_vid
 * - user.id = signed-in account, cookie strada_uid
 * - Context (session.id, visitor.id, url.*, user.id) injected into every span and log
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
// JSON-only OTLP exporters (no protobufjs) — see @strada.sh/otlp-json.
import { OTLPTraceExporter, OTLPLogExporter } from "@strada.sh/otlp-json";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { logs } from "@opentelemetry/api-logs";
import type { Logger } from "@opentelemetry/api-logs";

import {
  type BatchSpanProcessorBrowserConfig,
  type StradaOptions,
  type CaptureExceptionOptions,
  type StradaLogger,
  applyBeforeSend,
  normalizeError,
  shouldIgnoreError,
  errorToAttributes,
  recordExceptionOnSpan,
  createStradaLogger,
  setTags,
  resetContext,
  resolveUserId,
  setRuntimeUserId,
  readCookie,
  writeUserIdCookie,
  clearUserIdCookie,
  writeVisitorCookie,
  resolveBatchOptions,
  resolveEndpoint,
  resolveReleaseAttributes,
  shouldExportTelemetry,
  tryTelemetry,
  tryTelemetryAsync,
  ATTR,
  createStradaBaggage,
  BAGGAGE_SESSION_ID,
  BAGGAGE_USER_ID,
  DEFAULT_VISITOR_COOKIE,
  DEFAULT_USER_ID_COOKIE,
  DEFAULT_USER_ID_COOKIE_MAX_AGE,
  type StradaUserIdentity,
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
  type StradaUserIdentity,
  type StartSpanOptions,
  type DisposableSpan,
  setTags,
  startSpan,
  startInactiveSpan,
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
export type { StradaLogger } from "./shared.ts";

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

export function getOrCreateVisitor(): { id: string; firstVisit: boolean } {
  const existing = readCookie(DEFAULT_VISITOR_COOKIE);
  if (existing) {
    writeVisitorCookie({ value: existing });
    return { id: existing, firstVisit: false };
  }
  const id = crypto.randomUUID();
  writeVisitorCookie({ value: id });
  return { id, firstVisit: true };
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
    const message = String(record.attributes?.[ATTR["exception.message"]] ?? "");
    const stack = String(record.attributes?.[ATTR["exception.stacktrace"]] ?? "");

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
    private readonly getVisitorId: () => string | undefined,
    private readonly getUserId: () => string | undefined,
  ) {}

  onStart(span: Span): void {
    const sessionId = this.getSessionId();
    span.setAttribute(ATTR["session.id"], sessionId);
    const visitorId = this.getVisitorId();
    if (visitorId) {
      span.setAttribute(ATTR["visitor.id"], visitorId);
    }

    // Pageview spans already have dest URL from startPageSpan(). Writing
    // window.location here would overwrite /checkout with /pricing during
    // a navigate event, before the browser commits the new URL.
    if (typeof window !== "undefined" && span.name !== "pageview") {
      for (const [key, value] of Object.entries(getPageAttributes())) {
        if (value) {
          span.setAttribute(key, value);
        }
      }
    }

    const userId = this.getUserId();
    if (userId) {
      span.setAttribute(ATTR["user.id"], userId);
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
    private readonly getVisitorId: () => string | undefined,
    private readonly getUserId: () => string | undefined,
  ) {}

  onEmit(...args: Parameters<LogRecordProcessor["onEmit"]>): void {
    const record = args[0];

    // Inject analytics context into the log record
    record.setAttribute(ATTR["session.id"], this.getSessionId());
    const visitorId = this.getVisitorId();
    if (visitorId) {
      record.setAttribute(ATTR["visitor.id"], visitorId);
    }
    if (typeof window !== "undefined") {
      record.setAttribute(ATTR["url.path"], window.location.pathname);
      record.setAttribute(ATTR["url.full"], window.location.href);
    }
    const userId = this.getUserId();
    if (userId) {
      record.setAttribute(ATTR["user.id"], userId);
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
let _visitorId: string | undefined;
let _firstVisit: boolean | undefined;
let _currentPageviewSpan: ApiSpan | undefined;
let _errorListener: ((event: ErrorEvent) => void) | undefined;
let _rejectionListener: ((event: PromiseRejectionEvent) => void) | undefined;
let _visibilityListener: (() => void) | undefined;
let _navigateListener: ((event: NavigateEvent) => void) | undefined;

export function getLogger(name = "strada-web"): StradaLogger {
  return createStradaLogger(
    (loggerName) => _loggerProvider?.getLogger(loggerName),
    () => getBrowserWorkContext(context.active(), _currentPageviewSpan),
    name,
  );
}

function getPageAttributes(
  url: URL = new URL(window.location.href),
  referrer: string = document.referrer,
): Record<string, string> {
  return {
    [ATTR["url.path"]]: url.pathname,
    [ATTR["url.query"]]: url.search,
    [ATTR["url.full"]]: url.href,
    ...(referrer ? { [ATTR["http.request.header.referer"]]: referrer } : {}),
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
export function initStrada(options: StradaOptions): Error | undefined {
  return tryTelemetry({
    operation: "initStrada()",
    run: () => {
      setupStrada(options);
    },
  });
}

/**
 * The real setup. Split out so the public entry point can turn a throw into a
 * returned Error: a broken telemetry setup must never stop an app from
 * booting. The app runs with telemetry off instead.
 */
function setupStrada(options: StradaOptions): void {
  if (_tracerProvider) {
    console.warn("[@strada.sh/sdk] initStrada() was already called. Ignoring duplicate init.");
    return;
  }

  _options = options;
  _sessionId = getOrCreateSessionId();
  const visitor = getOrCreateVisitor();
  _visitorId = visitor.id;
  _firstVisit = visitor.firstVisit;
  if (options.token) {
    console.warn("[@strada.sh/sdk] token is ignored in browser builds. Browser ingest is anonymous and rate limited.");
  }

  const getUserId = () => resolveUserId(_options);
  const getVisitorId = () => _visitorId;

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
        browserAttrs[ATTR["browser.platform"]] = platform;
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
          browserAttrs[ATTR["browser.brands"]] = normalizedBrands;
        }
      }
      if (typeof mobile === "boolean") {
        browserAttrs[ATTR["browser.mobile"]] = mobile;
      }
    }
    if (navigator.userAgent) {
      browserAttrs[ATTR["user_agent.original"]] = navigator.userAgent;
    }
    if (navigator.language) {
      browserAttrs[ATTR["browser.language"]] = navigator.language;
    }
  }

  const resource = resourceFromAttributes({
    [ATTR["service.name"]]: options.service,
    ...resolveReleaseAttributes(options),
    ...(options.environment ? { [ATTR["deployment.environment.name"]]: options.environment } : {}),
    ...browserAttrs,
  });

  const exportTelemetry = shouldExportTelemetry(options);
  const endpoint = exportTelemetry ? resolveEndpoint(options) : undefined;

  // Tracer provider with context-injecting processor
  _tracerProvider = new WebTracerProvider({
    resource,
    spanProcessors: [
      new StradaSpanProcessor(() => _sessionId!, getVisitorId, getUserId),
      ...(exportTelemetry
        ? [
            new BatchSpanProcessor(
              new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
              resolveBatchOptions(options.telemetry?.traces),
            ),
          ]
        : []),
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
  _loggerProvider = new LoggerProvider({
    resource,
    processors: exportTelemetry
      ? [
          new ContextLogProcessor(
            new FilteringLogProcessor(
              new BatchLogRecordProcessor(
                new OTLPLogExporter({ url: `${endpoint}/v1/logs` }),
                resolveBatchOptions(options.telemetry?.logs),
              ),
            ),
            () => _sessionId!,
            getVisitorId,
            getUserId,
          ),
        ]
      : [],
  });
  logs.setGlobalLoggerProvider(_loggerProvider);
  _logger = _loggerProvider.getLogger("strada-web");

  // Start first pageview span
  startPageSpan();

  // Global error handlers
  // The SDK's own handlers deliberately drop the Error that captureException
  // returns: there is nobody left to report it to, and tryTelemetry already
  // logged it. Reporting it again here would recurse.
  _errorListener = (event: ErrorEvent) => {
    const error = event.error;
    if (error instanceof Error) {
      void captureException(error, { handled: false, mechanism: "onerror" });
    } else if (typeof event.message === "string" && event.message) {
      void captureException(new Error(event.message), {
        handled: false,
        mechanism: "onerror",
      });
    }
  };

  _rejectionListener = (event: PromiseRejectionEvent) => {
    const error = normalizeError(event.reason);
    void captureException(error, {
      handled: false,
      mechanism: "unhandledrejection",
    });
  };

  window.addEventListener("error", _errorListener);
  window.addEventListener("unhandledrejection", _rejectionListener);

  // End the current pageview on tab hide so duration is recorded. Do not start
  // a new pageview on focus: that would count tab switches as extra hits.
  _visibilityListener = () => {
    if (document.visibilityState === "hidden") {
      endCurrentPageSpan();
    }
  };
  document.addEventListener("visibilitychange", _visibilityListener);

  // SPA navigation via the Navigation API. intercepts history.pushState,
  // replaceState, and back/forward. No History monkey-patch needed.
  if (typeof navigation !== "undefined") {
    _navigateListener = (event: NavigateEvent) => {
      if (!event.canIntercept) return;
      if (!event.destination.sameDocument) return;
      if (event.navigationType === "reload") return;

      const dest = new URL(event.destination.url);
      const currentPath = window.location.pathname + window.location.search;
      const newPath = dest.pathname + dest.search;
      if (newPath === currentPath) return;

      startPageSpan(dest, {
        [ATTR["navigation.type"]]: event.navigationType,
        [ATTR["navigation.user_initiated"]]: event.userInitiated,
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
  const firstVisit = _firstVisit === true;
  _firstVisit = false;
  _currentPageviewSpan = tracer.startSpan("pageview", {
    attributes: {
      [ATTR["session.id"]]: _sessionId ?? "",
      ...(firstVisit ? { [ATTR["visitor.first_visit"]]: true } : {}),
      [ATTR["pageview.source"]]: "browser",
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
): Error | undefined {
  return tryTelemetry({
    operation: "track()",
    run: () => {
      if (!_logger) {
        console.warn("[@strada.sh/sdk] track() called before initStrada(). Event was not sent.");
        return;
      }

      const attributes: Record<string, string | number | boolean> = {
        [ATTR["event.name"]]: name,
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
    },
  });
}

// ---------------------------------------------------------------------------
// User identity
// ---------------------------------------------------------------------------

/**
 * Update signed-in user identity after login/logout.
 *
 * The browser runtime persists user.id in cookie `strada_uid` so a refresh
 * still has the account. Cookie `strada_vid` is the visitor and is not
 * written or cleared here. Call identifyUser() from a trusted server
 * runtime to emit the profile event extracted into otel_users.
 */
export function identifyUser(user: StradaUserIdentity | null): Error | undefined {
  return tryTelemetry({
    operation: "identifyUser()",
    run: () => {
      const cookieName = typeof _options?.userIdCookie === "string"
        ? _options.userIdCookie
        : DEFAULT_USER_ID_COOKIE;

      if (user === null) {
        setRuntimeUserId(null);
        if (_options?.userIdCookie !== false) {
          clearUserIdCookie(cookieName);
        }
        return;
      }

      setRuntimeUserId(user.id);
      if (_options?.userIdCookie !== false) {
        writeUserIdCookie({
          name: cookieName,
          value: user.id,
          maxAge: DEFAULT_USER_ID_COOKIE_MAX_AGE,
        });
      }
    },
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
): Error | undefined {
  return tryTelemetry({
    operation: "captureException()",
    run: () => {
      const normalized = normalizeError(error);

      if (_options && shouldIgnoreError(normalized, _options)) return;
      const prepared = applyBeforeSend(normalized, _options?.beforeSend);
      if (prepared === null) return;

      const attributes = errorToAttributes(prepared, opts);
      if (opts?.handled === false) {
        recordExceptionOnSpan(prepared, trace.getActiveSpan() ?? _currentPageviewSpan);
      }

      if (!_logger) {
        console.warn("[@strada.sh/sdk] captureException called before initStrada(). Error was not sent.");
        return;
      }

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
    },
  });
}

// ---------------------------------------------------------------------------
// Flush / Shutdown
// ---------------------------------------------------------------------------

/**
 * Flush all buffered telemetry (logs, traces).
 */
export async function flush(): Promise<Error | undefined> {
  return tryTelemetryAsync({
    operation: "flush()",
    run: async () => {
      await _loggerProvider?.forceFlush();
      await _tracerProvider?.forceFlush();
    },
  });
}

/**
 * Shut down the SDK, flush remaining telemetry, and remove global handlers.
 */
export async function shutdown(): Promise<Error | undefined> {
  const error = await tryTelemetryAsync({
    operation: "shutdown()",
    run: async () => {
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
    },
  });
  // Reset even when shutdown failed, otherwise the SDK is left half alive.
  _tracerProvider = undefined;
  _loggerProvider = undefined;
  _logger = undefined;
  _options = undefined;
  _sessionId = undefined;
  _visitorId = undefined;
  _firstVisit = undefined;
  resetContext();
  return error;
}
