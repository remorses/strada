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
 * Uses BasicTracerProvider from sdk-trace-base (no Node/browser dependencies)
 * with AsyncLocalStorage for context propagation (requires nodejs_compat).
 * Auto-flushes via `waitUntil` from `cloudflare:workers` so the user never
 * needs to call flush() or pass ctx around.
 *
 * Env type comes from wrangler types (worker-configuration.d.ts), never define
 * custom Env interfaces. See the cloudflare-workers skill for conventions.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { waitUntil } from "cloudflare:workers";

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
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
import type { Context, ContextManager } from "@opentelemetry/api";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";

import {
  type StradaOptions,
  type CaptureExceptionOptions,
  type StradaTelemetryOptions,
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
  ATTR,
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
  type StartSpanOptions,
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
  onStart(span: Span): void {
    const baggage = propagation.getBaggage(otelContext.active());
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

  // Register globals manually (BasicTracerProvider has no register() method)
  trace.setGlobalTracerProvider(_tracerProvider);
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
