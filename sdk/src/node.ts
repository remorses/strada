/**
 * Node.js runtime entry for @strada.sh/sdk.
 *
 * Wires OTel providers directly (NodeTracerProvider, MeterProvider,
 * LoggerProvider) instead of using @opentelemetry/sdk-node which pulls in
 * every exporter variant (gRPC, proto, zipkin, prometheus), YAML config
 * parsing, and ~2MB of unnecessary dependencies. We only need HTTP/JSON.
 *
 * Vercel auto-detection: when VERCEL=1 is set, the SDK switches from
 * timer-based batch flushing to per-span/log waitUntil flushing. Vercel
 * freezes the Node.js process between requests so batch timers never fire,
 * and kills it on scale-to-zero so buffered data is lost. waitUntil keeps
 * the function alive until telemetry is delivered. No extra imports needed —
 * Vercel exposes waitUntil via globalThis[Symbol.for('@vercel/request-context')].
 */

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  type BatchLogRecordProcessorBrowserConfig,
  LoggerProvider,
  BatchLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  defaultResource,
  detectResources,
  envDetector,
  processDetector,
  hostDetector,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import { logs } from "@opentelemetry/api-logs";
import type { Logger } from "@opentelemetry/api-logs";
import { context as otelContext, metrics, propagation, trace } from "@opentelemetry/api";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";

import {
  type BatchSpanProcessorBrowserConfig,
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
  resolveMetricReaderOptions,
  resolveBatchOptions,
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
// Vercel waitUntil (no package import — reads from native request context)
// ---------------------------------------------------------------------------
// Vercel populates globalThis[Symbol.for('@vercel/request-context')] on every
// request. Calling .waitUntil() on it keeps the function alive after the HTTP
// response is sent, preventing buffered telemetry from being dropped on freeze
// or scale-to-zero.
//
// Detection: we read the native request context directly rather than checking
// process.env.VERCEL, because Vercel only sets that env var when "System
// Environment Variables" are enabled in project settings — a valid Vercel
// deployment can have the request context without the env var.
//
// Pattern from spiceflow's wait-until.ts and @vercel/functions source:
//   https://npmx.dev/package-code/@vercel/functions/v/3.4.3/wait-until.js

const _VERCEL_CTX = Symbol.for("@vercel/request-context");

function getNativeVercelWaitUntil(): ((p: Promise<unknown>) => void) | undefined {
  return (globalThis as any)[_VERCEL_CTX]?.get?.()?.waitUntil;
}

// ---------------------------------------------------------------------------
// Auto-flush processors (always installed, no-op when not on Vercel)
// ---------------------------------------------------------------------------
// BatchSpanProcessor timers are suspended when Vercel freezes the process
// between requests. AutoFlushSpanProcessor and AutoFlushLogProcessor call
// scheduleFlush() after each span/log. scheduleFlush() checks for the native
// Vercel waitUntil at call time — if it's present (i.e. we're inside a Vercel
// request), it registers a flush that keeps the function alive. If not (local
// dev, long-running server), it's a no-op so batch timers handle export as usual.

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

let _flushScheduled = false;

function scheduleFlush(): void {
  // Only activate when Vercel's native waitUntil is present in the current
  // request context. On a regular long-running Node.js server this returns
  // undefined and we skip the flush — batch timers handle export as usual.
  const waitUntil = getNativeVercelWaitUntil();
  if (!waitUntil) return;

  if (_flushScheduled) return;
  _flushScheduled = true;
  waitUntil(
    Promise.resolve().then(async () => {
      _flushScheduled = false;
      await Promise.all([
        _tracerProvider?.forceFlush(),
        _loggerProvider?.forceFlush(),
        _meterProvider?.forceFlush(),
      ]);
    }),
  );
}

// ---------------------------------------------------------------------------
// Baggage-extracting span processor
// ---------------------------------------------------------------------------

/**
 * Reads session.id and user.id from incoming W3C Baggage (propagated by the
 * browser SDK) and sets them as span attributes. This means every backend
 * span created within a browser-initiated request automatically carries the
 * browser session and user context without the app developer doing anything.
 */
class BaggageSpanProcessor implements SpanProcessor {
  onStart(span: Span): void {
    const baggage = propagation.getBaggage(otelContext.active());
    if (!baggage) return;

    const sessionId = baggage.getEntry(BAGGAGE_SESSION_ID)?.value;
    if (sessionId) {
      span.setAttribute(ATTR["session.id"], sessionId);
    }

    const userId = baggage.getEntry(BAGGAGE_USER_ID)?.value;
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
// Baggage-extracting log processor
// ---------------------------------------------------------------------------

/**
 * Wraps another LogRecordProcessor and injects session.id and user.id from
 * incoming W3C Baggage into every log record. This means backend custom
 * events (track()) and error logs within a browser-initiated request are
 * automatically correlated to the browser session.
 */
class BaggageLogProcessor implements LogRecordProcessor {
  constructor(private readonly inner: LogRecordProcessor) {}

  onEmit(...args: Parameters<LogRecordProcessor["onEmit"]>): void {
    const record = args[0];
    const baggage = propagation.getBaggage(otelContext.active());
    if (baggage) {
      const sessionId = baggage.getEntry(BAGGAGE_SESSION_ID)?.value;
      if (sessionId) {
        record.setAttribute(ATTR["session.id"], sessionId);
      }

      const userId = baggage.getEntry(BAGGAGE_USER_ID)?.value;
      if (userId) {
        record.setAttribute(ATTR["user.id"], userId);
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
// Module state
// ---------------------------------------------------------------------------

let _tracerProvider: NodeTracerProvider | undefined;
let _meterProvider: MeterProvider | undefined;
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
 * Initialize Strada for Node.js. Call this once at app startup, before any
 * application code runs (ideally in a separate instrumentation.ts loaded
 * via --import).
 *
 * On Vercel, automatically switches to waitUntil-based flushing so telemetry
 * is not lost when the function freezes or scales to zero. Detected via
 * Vercel's native request context (not process.env.VERCEL which is unreliable).
 * No extra imports or config needed — works automatically.
 *
 * This sets up:
 * - NodeTracerProvider with BaggageSpanProcessor + BatchSpanProcessor (HTTP/JSON)
 * - MeterProvider with PeriodicExportingMetricReader (HTTP/JSON)
 * - LoggerProvider with BaggageLogProcessor + BatchLogRecordProcessor (HTTP/JSON)
 * - W3C TraceContext + Baggage propagation
 * - Auto-instrumentation (http, express, pg, mysql, redis, etc.) if installed
 * - Global uncaughtException / unhandledRejection handlers
 * - captureException() for manual error reporting
 */
export function initStrada(options: StradaOptions): void {
  if (_tracerProvider) {
    console.warn(
      "[@strada.sh/sdk] initStrada() was already called. Ignoring duplicate init.",
    );
    return;
  }

  _options = options;

  // Build resource by merging layers, same as NodeSDK did:
  // 1. defaultResource() adds telemetry.sdk.* attributes
  // 2. detectResources() adds process.*, host.*, and OTEL_RESOURCE_ATTRIBUTES
  // 3. Our custom service.* attributes take highest priority (last merge wins)
  const resource = defaultResource()
    .merge(detectResources({ detectors: [envDetector, processDetector, hostDetector] }))
    .merge(
      resourceFromAttributes({
        [ATTR["service.name"]]: options.service,
        ...resolveReleaseAttributes(options, process.env),
        ...(options.environment
          ? { [ATTR["deployment.environment.name"]]: options.environment }
          : {}),
      }),
    );

  const exportTelemetry = shouldExportTelemetry(options);
  const endpoint = exportTelemetry ? resolveEndpoint(options) : undefined;
  const ingestHeaders = resolveIngestHeaders(options);

  // Log provider (used for both logs and error capture).
  // Wrapped in BaggageLogProcessor to extract session.id and user.id from
  // incoming W3C Baggage (propagated by the browser SDK via fetch headers).
  // AutoFlushLogProcessor calls scheduleFlush() on every emit — scheduleFlush()
  // is a no-op unless Vercel's native waitUntil is present in the request context,
  // so this adds zero overhead on regular long-running servers.
  _loggerProvider = new LoggerProvider({
    resource,
    processors: exportTelemetry
      ? [
          new AutoFlushLogProcessor(
            new BaggageLogProcessor(
              new BatchLogRecordProcessor(
                new OTLPLogExporter({ url: `${endpoint}/v1/logs`, headers: ingestHeaders }),
                resolveBatchOptions(options.telemetry?.logs),
              ),
            ),
          ),
        ]
      : [],
  });
  logs.setGlobalLoggerProvider(_loggerProvider);
  _logger = _loggerProvider.getLogger("strada");

  // Tracer provider with BaggageSpanProcessor to extract session.id and
  // user.id from incoming W3C Baggage, plus BatchSpanProcessor for export.
  // AutoFlushSpanProcessor calls scheduleFlush() on every span end — no-op
  // unless Vercel's native waitUntil is present in the current request context.
  const spanProcessors: SpanProcessor[] = [
    new BaggageSpanProcessor(),
    ...(exportTelemetry
      ? [
          new BatchSpanProcessor(
            new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers: ingestHeaders }),
            resolveBatchOptions(options.telemetry?.traces),
          ),
          new AutoFlushSpanProcessor(),
        ]
      : []),
  ];

  _tracerProvider = new NodeTracerProvider({ resource, spanProcessors });
  // register() sets global tracer provider, enables AsyncLocalStorageContextManager,
  // and configures W3C TraceContext + Baggage propagation.
  _tracerProvider.register({
    propagator: new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    }),
  });

  // Meter provider for metrics export via HTTP/JSON.
  _meterProvider = new MeterProvider({
    resource,
    readers: exportTelemetry
      ? [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics`, headers: ingestHeaders }),
            ...resolveMetricReaderOptions(options),
          }),
        ]
      : [],
  });
  metrics.setGlobalMeterProvider(_meterProvider);

  // Global error handlers
  process.on("uncaughtException", (error) => {
    captureException(error, {
      handled: false,
      mechanism: "uncaughtException",
    });
    flush()
      .catch(() => {})
      .finally(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    const error = normalizeError(reason);
    captureException(error, {
      handled: false,
      mechanism: "unhandledRejection",
    });
  });

  // Graceful shutdown
  const shutdownHandler = () => {
    shutdown().catch(() => {});
  };
  process.on("SIGTERM", shutdownHandler);
  process.on("SIGINT", shutdownHandler);
}

// ---------------------------------------------------------------------------
// Public API
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
  } else {
    console.warn(
      "[@strada.sh/sdk] captureException called before initStrada(). Error was not sent.",
    );
  }
}

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
 * Flush all buffered telemetry (logs, traces, metrics).
 * Call this before process exit to ensure nothing is lost.
 */
export async function flush(): Promise<void> {
  await Promise.all([
    _loggerProvider?.forceFlush(),
    _tracerProvider?.forceFlush(),
    _meterProvider?.forceFlush(),
  ]);
}

/**
 * Shut down the SDK and flush remaining telemetry.
 */
export async function shutdown(): Promise<void> {
  await Promise.all([
    _tracerProvider?.shutdown(),
    _meterProvider?.shutdown(),
    _loggerProvider?.shutdown(),
  ]);
  _tracerProvider = undefined;
  _meterProvider = undefined;
  _loggerProvider = undefined;
  _logger = undefined;
  _options = undefined;
  resetContext();
}
