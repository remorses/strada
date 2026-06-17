/**
 * Cloudflare Workers runtime entry for @strada.sh/sdk.
 *
 * Minimal, opt-in only. No automatic instrumentation, no automatic spans.
 * The SDK only sends data to the collector when user code explicitly calls
 * captureException(), trace.getTracer().startSpan(), or logs.getLogger().emit().
 * If none of these are called, zero HTTP requests are made.
 *
 * For automatic instrumentation of KV, D1, DO, fetch, etc., use Cloudflare's
 * built-in tracing instead: { "observability": { "traces": { "enabled": true } } }
 * in wrangler.jsonc. It instruments at the runtime level, better than any
 * userland SDK can.
 *
 * When Cloudflare native tracing is available (tracing.enterSpan from
 * cloudflare:workers, workerd 2026-06-16+), the SDK automatically bridges
 * every startActiveSpan() call to also create a native CF span. This makes
 * OTel custom spans visible in Cloudflare's trace waterfall alongside
 * auto-instrumented KV/D1/fetch spans. Disable with cloudflareTracing: false.
 *
 * Uses BasicTracerProvider from sdk-trace-base (no Node/browser dependencies)
 * with AsyncLocalStorage for context propagation (requires nodejs_compat).
 * Auto-flushes via `waitUntil` from `cloudflare:workers` so the user never
 * needs to call flush() or pass ctx around.
 *
 * Env type comes from wrangler types (worker-configuration.d.ts), never define
 * custom Env interfaces. See the cloudflare-workers skill for conventions.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as cfWorkers from "cloudflare:workers";
import type { CloudflareSpan as CfNativeSpan } from "cloudflare:workers";

// Destructure with fallbacks for older workerd versions where tracing
// may not be exported yet.
const { waitUntil } = cfWorkers;
const cfTracing = "tracing" in cfWorkers ? (cfWorkers as any).tracing as typeof cfWorkers.tracing | undefined : undefined;

// OTLP/HTTP JSON exporters come from @strada.sh/otlp-json, NOT from
// @opentelemetry/exporter-{trace,logs}-otlp-http. The official exporters pull
// in @opentelemetry/otlp-transformer -> protobufjs (via a barrel re-export of
// the protobuf serializers), and protobufjs's @protobufjs/inquire does a bare
// require() that crashes under workerd (`ReferenceError: moduleName is not
// defined`). The vendored package only contains the JSON serialization path
// plus a tiny fetch-based exporter, so protobuf never enters the bundle.
import { OTLPTraceExporter, OTLPLogExporter } from "@strada.sh/otlp-json";
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { logs } from "@opentelemetry/api-logs";
import type { Logger } from "@opentelemetry/api-logs";
import {
  context as otelContext,
  propagation,
  trace,
  ROOT_CONTEXT,
} from "@opentelemetry/api";
import type {
  Context,
  ContextManager,
  Span as OtelSpan,
  SpanOptions,
  Tracer,
  TracerProvider,
  TracerOptions,
  SpanAttributeValue,
} from "@opentelemetry/api";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";

import {
  type StradaOptions,
  type CaptureExceptionOptions,
  type StradaTelemetryOptions,
  type TrackPageviewOptions,
  type StradaLogger,
  applyBeforeSend,
  normalizeError,
  shouldIgnoreError,
  errorToAttributes,
  recordExceptionOnSpan,
  createStradaLogger,
  setTags,
  resetContext,
  resolveEndpoint,
  resolveIngestHeaders,
  resolveReleaseAttributes,
  shouldExportTelemetry,
  emitUserIdentifyLog,
  buildPageviewAttributes,
  ATTR,
  BAGGAGE_SESSION_ID,
  BAGGAGE_USER_ID,
  SPAN_CONTEXT_ATTR_KEYS,
  readSpanAttributes,
  deriveUrlPath,
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
  type TrackPageviewOptions,
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
// Context manager for Workers (requires nodejs_compat)
// ---------------------------------------------------------------------------

class WorkerContextManager implements ContextManager {
  private storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const cb = thisArg == null ? fn : fn.bind(thisArg);
    return this.storage.run(context, cb as never, ...args);
  }

  bind<T>(context: Context, target: T): T {
    if (typeof target === "function") {
      const manager = this;
      return function (this: unknown, ...args: unknown[]) {
        return manager.with(context, () =>
          (target as Function).apply(this, args),
        );
      } as T;
    }
    return target;
  }

  enable(): this {
    return this;
  }
  disable(): this {
    return this;
  }
}

// ---------------------------------------------------------------------------
// Auto-flush via waitUntil
// ---------------------------------------------------------------------------
// Debounced per-microtask: multiple span ends / log emits in the same tick
// share one flush. If no telemetry is buffered, forceFlush resolves
// immediately without making any HTTP requests.

let _flushScheduled = false;

function scheduleFlush(): void {
  if (_flushScheduled) return;
  _flushScheduled = true;
  waitUntil(
    Promise.resolve().then(async () => {
      _flushScheduled = false;
      await Promise.all([
        _tracerProvider?.forceFlush(),
        _loggerProvider?.forceFlush(),
      ]);
    }),
  );
}

// ---------------------------------------------------------------------------
// Auto-flush span processor
// ---------------------------------------------------------------------------
// Triggers scheduleFlush() when a span ends so manual spans are exported
// without the user needing to call flush() or pass ctx.waitUntil().

class AutoFlushSpanProcessor implements SpanProcessor {
  onStart(): void {}

  onEnd(): void {
    scheduleFlush();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Auto-flush log processor
// ---------------------------------------------------------------------------
// Wraps another LogRecordProcessor and triggers scheduleFlush() after every
// log emit (captureException, manual logger.emit, etc.).

class AutoFlushLogProcessor implements LogRecordProcessor {
  constructor(private readonly inner: LogRecordProcessor) {}

  onEmit(...args: Parameters<LogRecordProcessor["onEmit"]>): void {
    this.inner.onEmit(...args);
    scheduleFlush();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Baggage-extracting span processor (same as node.ts)
// ---------------------------------------------------------------------------

class BaggageSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const spanAttrs = readSpanAttributes(span) ?? {};
    const has = (key: string) =>
      Object.prototype.hasOwnProperty.call(spanAttrs, key);

    // Normalize the child's own old HTTP semconv into url.path first
    if (!has(ATTR["url.path"])) {
      const derivedFromChild = deriveUrlPath(spanAttrs);
      if (derivedFromChild) span.setAttribute(ATTR["url.path"], derivedFromChild);
    }

    // Propagate curated context attrs from parent span to child.
    // Only set if the child doesn't already have the key.
    const parentSpan = trace.getSpan(parentContext);
    if (parentSpan) {
      const parentAttrs = readSpanAttributes(parentSpan);
      if (parentAttrs) {
        for (const key of SPAN_CONTEXT_ATTR_KEYS) {
          const value = parentAttrs[key];
          if (value != null && !has(key)) span.setAttribute(key, String(value));
        }
        if (!has(ATTR["url.path"]) && !spanAttrs[ATTR["url.path"]]) {
          const derivedFromParent = deriveUrlPath(parentAttrs);
          if (derivedFromParent) span.setAttribute(ATTR["url.path"], derivedFromParent);
        }
      }
    }

    const baggage = propagation.getBaggage(parentContext);
    if (!baggage) return;

    const sessionId = baggage.getEntry(BAGGAGE_SESSION_ID)?.value;
    if (sessionId) span.setAttribute(ATTR["session.id"], sessionId);

    const userId = baggage.getEntry(BAGGAGE_USER_ID)?.value;
    if (userId) span.setAttribute(ATTR["user.id"], userId);
  }

  onEnd(): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Baggage-extracting log processor (same as node.ts)
// ---------------------------------------------------------------------------

class BaggageLogProcessor implements LogRecordProcessor {
  constructor(private readonly inner: LogRecordProcessor) {}

  onEmit(...args: Parameters<LogRecordProcessor["onEmit"]>): void {
    const record = args[0];
    const baggage = propagation.getBaggage(otelContext.active());
    if (baggage) {
      const sessionId = baggage.getEntry(BAGGAGE_SESSION_ID)?.value;
      if (sessionId) record.setAttribute(ATTR["session.id"], sessionId);

      const userId = baggage.getEntry(BAGGAGE_USER_ID)?.value;
      if (userId) record.setAttribute(ATTR["user.id"], userId);
    }

    // Inject request-scoped context from the active span (url.path,
    // http.route, etc.) so captureException() and track() calls inside
    // request handlers automatically carry the request URL.
    const activeSpan = trace.getSpan(otelContext.active());
    if (activeSpan) {
      const spanAttrs = readSpanAttributes(activeSpan);
      if (spanAttrs) {
        for (const key of SPAN_CONTEXT_ATTR_KEYS) {
          const value = spanAttrs[key];
          if (value != null && !Object.prototype.hasOwnProperty.call(record.attributes, key)) {
            record.setAttribute(key, String(value));
          }
        }
        if (!Object.prototype.hasOwnProperty.call(record.attributes, ATTR["url.path"])) {
          const derived = deriveUrlPath(spanAttrs);
          if (derived) record.setAttribute(ATTR["url.path"], derived);
        }
      }
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
// Cloudflare native tracing bridge
// ---------------------------------------------------------------------------
// When Cloudflare's tracing.enterSpan() is available, these wrappers ensure
// every startActiveSpan() call also creates a native CF span. This makes OTel
// spans visible in Cloudflare's trace waterfall alongside auto-instrumented
// KV/D1/fetch/R2 spans, while still exporting via OTLP to Strada.
//
// startSpan() (inactive spans) cannot bridge because CF's API is callback-
// scoped only. Those spans still export to Strada via OTLP as before.

/**
 * Proxy span that forwards setAttribute to both the OTel span and the
 * Cloudflare native span. All other methods delegate to the OTel span only.
 */
class BridgedSpan implements OtelSpan {
  constructor(
    private readonly otel: OtelSpan,
    private readonly cf: CfNativeSpan,
  ) {}

  spanContext() {
    return this.otel.spanContext();
  }

  setAttribute(key: string, value: SpanAttributeValue): this {
    this.otel.setAttribute(key, value);
    // CF spans only accept string | number | boolean | undefined.
    // Skip arrays and objects silently; they are OTel-only attributes.
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === undefined
    ) {
      this.cf.setAttribute(key, value);
    }
    return this;
  }

  setAttributes(attributes: Record<string, SpanAttributeValue>): this {
    for (const [k, v] of Object.entries(attributes)) {
      this.setAttribute(k, v);
    }
    return this;
  }

  addEvent(...args: Parameters<OtelSpan["addEvent"]>): this {
    this.otel.addEvent(...args);
    return this;
  }

  addLink(...args: Parameters<OtelSpan["addLink"]>): this {
    this.otel.addLink(...args);
    return this;
  }

  addLinks(...args: Parameters<OtelSpan["addLinks"]>): this {
    this.otel.addLinks(...args);
    return this;
  }

  setStatus(...args: Parameters<OtelSpan["setStatus"]>): this {
    this.otel.setStatus(...args);
    return this;
  }

  updateName(name: string): this {
    this.otel.updateName(name);
    return this;
  }

  end(endTime?: Parameters<OtelSpan["end"]>[0]): void {
    this.otel.end(endTime);
  }

  isRecording(): boolean {
    return this.otel.isRecording();
  }

  recordException(...args: Parameters<OtelSpan["recordException"]>): void {
    this.otel.recordException(...args);
  }
}

/**
 * Tracer wrapper that intercepts startActiveSpan() to create both an OTel
 * span and a Cloudflare native span via tracing.enterSpan().
 *
 * startSpan() (inactive) delegates directly to the inner tracer since CF's
 * API has no manual-lifetime equivalent.
 */
class BridgedTracer implements Tracer {
  constructor(private readonly inner: Tracer) {}

  startSpan(name: string, options?: SpanOptions, context?: Context): OtelSpan {
    return this.inner.startSpan(name, options, context);
  }

  startActiveSpan<F extends (span: OtelSpan) => unknown>(
    name: string,
    fnOrOptions: F | SpanOptions,
    fnOrContext?: F | Context,
    maybeFn?: F,
  ): ReturnType<F> {
    // Resolve the three overloads:
    //   (name, fn)              → arity 2
    //   (name, options, fn)     → arity 3
    //   (name, options, ctx, fn) → arity 4
    let fn: F;
    let arity: 2 | 3 | 4;

    if (typeof fnOrOptions === "function") {
      fn = fnOrOptions;
      arity = 2;
    } else if (typeof fnOrContext === "function") {
      fn = fnOrContext;
      arity = 3;
    } else {
      fn = maybeFn!;
      arity = 4;
    }

    // Wrap: CF enterSpan creates the native span, inside which the real
    // OTel startActiveSpan creates the OTel span. The user's callback
    // receives a BridgedSpan that forwards setAttribute to both.
    //
    // After the callback settles we copy all scalar OTel span attributes
    // to the CF span. This catches attributes from SpanOptions.attributes,
    // BaggageSpanProcessor.onStart(), and trace.getActiveSpan()?.setAttribute()
    // which bypass the BridgedSpan proxy.
    return cfTracing!.enterSpan(name, (cfSpan) => {
      const wrapFn = (otelSpan: OtelSpan) => {
        const bridged = new BridgedSpan(otelSpan, cfSpan) as unknown as OtelSpan;
        const result = fn(bridged);
        if (result instanceof Promise) {
          return result.finally(() => copyScalarAttributes(otelSpan, cfSpan));
        }
        copyScalarAttributes(otelSpan, cfSpan);
        return result;
      };

      // Forward with exact arity to match the overload the inner tracer expects.
      // Using explicit branches instead of dynamic args array avoids the bug
      // where undefined options/context would shift the positional arguments.
      const inner = this.inner.startActiveSpan as Function;
      if (arity === 2) return inner.call(this.inner, name, wrapFn);
      if (arity === 3) return inner.call(this.inner, name, fnOrOptions, wrapFn);
      return inner.call(this.inner, name, fnOrOptions, fnOrContext, wrapFn);
    }) as ReturnType<F>;
  }
}

/**
 * Copy all scalar attributes from an OTel SDK span to a CF native span.
 * Called after the user callback settles to catch attributes set by
 * SpanOptions.attributes, span processors, and trace.getActiveSpan().
 * The CF span may already have some attrs from BridgedSpan.setAttribute();
 * setAttribute is idempotent so duplicates are harmless.
 */
function copyScalarAttributes(otelSpan: OtelSpan, cfSpan: CfNativeSpan): void {
  const attrs = readSpanAttributes(otelSpan);
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      cfSpan.setAttribute(key, value);
    }
  }
}

/**
 * TracerProvider wrapper that returns BridgedTracer instances.
 */
class BridgedTracerProvider implements TracerProvider {
  constructor(private readonly inner: BasicTracerProvider) {}

  getTracer(name: string, version?: string, options?: TracerOptions): Tracer {
    return new BridgedTracer(this.inner.getTracer(name, version, options));
  }

  /** Proxy forceFlush to the inner provider. */
  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  /** Proxy shutdown to the inner provider. */
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _tracerProvider: BasicTracerProvider | undefined;
let _loggerProvider: LoggerProvider | undefined;
let _logger: Logger | undefined;
let _options: StradaOptions | undefined;

export function getLogger(name = "strada"): StradaLogger {
  return createStradaLogger((loggerName) => _loggerProvider?.getLogger(loggerName), undefined, name);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Initialize Strada for Cloudflare Workers. Call once per request (it's a
 * no-op after the first call). Config typically comes from env bindings.
 *
 * Sets up:
 * - BasicTracerProvider with AsyncLocalStorage context manager
 * - BaggageSpanProcessor for browser-to-server context propagation
 * - BatchSpanProcessor + AutoFlushSpanProcessor for automatic export
 * - LoggerProvider with BaggageLogProcessor + AutoFlushLogProcessor
 * - W3C TraceContext + Baggage propagation
 * - Cloudflare native tracing bridge (auto-detected, opt-out via
 *   cloudflareTracing: false). When enabled, startActiveSpan() calls
 *   also create CF native spans visible in the Cloudflare dashboard.
 *
 * No automatic spans or instrumentation. The SDK only sends data when
 * you explicitly call captureException(), trace.getTracer(), or logs.getLogger().
 */
export function initStrada(options: StradaOptions): void {
  if (_tracerProvider) return;
  _options = options;

  const resource = resourceFromAttributes({
    [ATTR["service.name"]]: options.service,
    ...resolveReleaseAttributes(options),
    ...(options.environment
      ? { [ATTR["deployment.environment.name"]]: options.environment }
      : {}),
    "cloud.provider": "cloudflare",
    "cloud.platform": "cloudflare.workers",
    [ATTR["faas.name"]]: options.service,
    [ATTR["cloudflare.script_name"]]: options.service,
    [ATTR["telemetry.sdk.name"]]: "strada",
    [ATTR["telemetry.sdk.language"]]: "javascript",
  });

  const exportTelemetry = shouldExportTelemetry(options);
  const endpoint = exportTelemetry ? resolveEndpoint(options) : undefined;
  const ingestHeaders = resolveIngestHeaders(options);

  // Logger provider: baggage extraction -> batch export -> auto-flush
  _loggerProvider = new LoggerProvider({
    resource,
    processors: exportTelemetry
      ? [
          new AutoFlushLogProcessor(
            new BaggageLogProcessor(
              new BatchLogRecordProcessor(
                new OTLPLogExporter({ url: `${endpoint}/v1/logs`, headers: ingestHeaders }),
                options.telemetry?.logs,
              ),
            ),
          ),
        ]
      : [],
  });
  logs.setGlobalLoggerProvider(_loggerProvider);
  _logger = _loggerProvider.getLogger("strada");

  // Tracer provider: baggage extraction + batch export + auto-flush
  _tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [
      new BaggageSpanProcessor(),
      ...(exportTelemetry
        ? [
            new BatchSpanProcessor(
              new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers: ingestHeaders }),
              options.telemetry?.traces,
            ),
            new AutoFlushSpanProcessor(),
          ]
        : []),
    ],
  });

  // Register globals manually (BasicTracerProvider has no register() method).
  // When Cloudflare native tracing is available, wrap the provider so that
  // startActiveSpan() also creates CF native spans via tracing.enterSpan().
  const useCfTracing =
    options.cloudflareTracing !== false &&
    typeof cfTracing?.enterSpan === "function";

  trace.setGlobalTracerProvider(
    useCfTracing
      ? new BridgedTracerProvider(_tracerProvider)
      : _tracerProvider,
  );
  otelContext.setGlobalContextManager(new WorkerContextManager());
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    }),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Capture an exception and send it to Strada as an OTel log record.
 * Auto-flushes via waitUntil; no need to call flush() or pass ctx.
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
  attributes[ATTR["cloudflare.outcome"]] = "exception";
  if (opts?.handled === false) {
    recordExceptionOnSpan(prepared);
  }

  if (_logger) {
    _logger.emit({
      eventName: "exception",
      severityNumber: ERROR_SEVERITY,
      severityText: ERROR_SEVERITY_TEXT,
      body: prepared.message,
      attributes,
    });
    // Auto-flush is handled by AutoFlushLogProcessor
  } else {
    console.warn(
      "[@strada.sh/sdk] captureException called before initStrada(). Error was not sent.",
    );
  }
}

/**
 * Emit a custom event as an OTel log record from a Cloudflare Worker.
 * Properties are namespaced under custom.* for consistency with browser events.
 */
export function track(
  name: string,
  properties?: Record<string, string | number | boolean>,
): void {
  if (!_logger) {
    console.warn(
      "[@strada.sh/sdk] track() called before initStrada(). Event was not sent.",
    );
    return;
  }

  const attributes: Record<string, string | number | boolean> = {
    [ATTR["event.name"]]: name,
  };

  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      attributes[`custom.${key}`] = value;
    }
  }

  _logger.emit({
    eventName: name,
    severityNumber: INFO_SEVERITY,
    severityText: INFO_SEVERITY_TEXT,
    body: name,
    attributes,
  });
}

/**
 * Track a server-side pageview as an OTel span. Emits a zero-duration span
 * with SpanName = 'pageview' and pageview.source = 'server', which flows
 * through the same analytics materialized views as browser pageview spans.
 *
 * Use this for traffic the browser SDK can't see: bots, AI crawlers,
 * JS-blocked visitors, or SSR-only pages. Auto-flushes via waitUntil.
 *
 * session.id and user.id are read from W3C Baggage on the active OTel
 * context when not passed explicitly, so browser-initiated requests
 * automatically inherit the browser session identity.
 *
 * @example
 * ```ts
 * export default {
 *   fetch(request, env) {
 *     initStrada({ projectId: '...', service: 'docs', token: env.STRADA_TOKEN })
 *     const url = new URL(request.url)
 *     trackPageview({ path: url.pathname, url: url.href })
 *   }
 * }
 * ```
 */
export function trackPageview(opts: TrackPageviewOptions): void {
  if (!_tracerProvider) {
    console.warn(
      "[@strada.sh/sdk] trackPageview() called before initStrada(). Pageview was not sent.",
    );
    return;
  }

  const baggage = propagation.getBaggage(otelContext.active());
  const attributes = buildPageviewAttributes(opts, baggage);

  const span = trace.getTracer("strada").startSpan("pageview", { attributes });
  span.end();
  // Auto-flush is handled by AutoFlushSpanProcessor
}

/** Emit a trusted user profile event over OTLP logs for extraction into otel_users. */
export function identifyUser(user: StradaUserIdentity): void {
  if (!_logger) {
    console.warn(
      "[@strada.sh/sdk] identifyUser() called before initStrada(). User profile was not sent.",
    );
    return;
  }

  emitUserIdentifyLog(_logger, user);
}

/**
 * Flush all buffered telemetry (traces and logs).
 * Usually not needed since the Workers entry auto-flushes via waitUntil
 * when telemetry is emitted. Call this only if you need to guarantee
 * delivery at a specific point.
 */
export async function flush(): Promise<void> {
  await Promise.all([
    _loggerProvider?.forceFlush(),
    _tracerProvider?.forceFlush(),
  ]);
}

/**
 * Shut down the SDK and flush remaining telemetry.
 * Rarely needed in Workers since isolates are ephemeral.
 */
export async function shutdown(): Promise<void> {
  await Promise.all([
    _tracerProvider?.shutdown(),
    _loggerProvider?.shutdown(),
  ]);
  _tracerProvider = undefined;
  _loggerProvider = undefined;
  _logger = undefined;
  _options = undefined;
  resetContext();
}
