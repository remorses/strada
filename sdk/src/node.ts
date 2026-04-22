/**
 * Node.js runtime entry for @strada.sh/sdk.
 *
 * Wires OTel providers directly (NodeTracerProvider, MeterProvider,
 * LoggerProvider) instead of using @opentelemetry/sdk-node which pulls in
 * every exporter variant (gRPC, proto, zipkin, prometheus), YAML config
 * parsing, and ~2MB of unnecessary dependencies. We only need HTTP/JSON.
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
  applyBeforeSend,
  normalizeError,
  shouldIgnoreError,
  errorToAttributes,
  setTags,
  resetContext,
  resolveMetricReaderOptions,
  resolveEndpoint,
  ATTR,
  BAGGAGE_SESSION_ID,
  BAGGAGE_USER_ID,
  ERROR_SEVERITY,
  ERROR_SEVERITY_TEXT,
} from "./shared.ts";

// Re-export shared types, helpers, and OTel primitives so users only need one import
export {
  type StradaOptions,
  type CaptureExceptionOptions,
  type StradaTelemetryOptions,
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
// Baggage-extracting span processor
// ---------------------------------------------------------------------------

/**
 * Reads session.id and enduser.id from incoming W3C Baggage (propagated by the
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
      span.setAttribute(ATTR["enduser.id"], userId);
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
 * Wraps another LogRecordProcessor and injects session.id and enduser.id from
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
        record.setAttribute(ATTR["enduser.id"], userId);
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

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Initialize Strada for Node.js. Call this once at app startup, before any
 * application code runs (ideally in a separate instrumentation.ts loaded
 * via --import).
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
    .merge(resourceFromAttributes({
      [ATTR["service.name"]]: options.service,
      ...(options.version ? { [ATTR["service.version"]]: options.version } : {}),
      ...(options.environment
        ? { [ATTR["deployment.environment.name"]]: options.environment }
        : {}),
    }));

  const endpoint = resolveEndpoint(options);

  // Log provider (used for both logs and error capture).
  // Wrapped in BaggageLogProcessor to extract session.id and enduser.id from
  // incoming W3C Baggage (propagated by the browser SDK via fetch headers).
  const logExporter = new OTLPLogExporter({
    url: `${endpoint}/v1/logs`,
  });
  _loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BaggageLogProcessor(new BatchLogRecordProcessor(logExporter)),
    ],
  });
  logs.setGlobalLoggerProvider(_loggerProvider);
  _logger = _loggerProvider.getLogger("strada");

  // Tracer provider with BaggageSpanProcessor to extract session.id and
  // enduser.id from incoming W3C Baggage, plus BatchSpanProcessor for export.
  _tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [
      new BaggageSpanProcessor(),
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      ),
    ],
  });
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
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${endpoint}/v1/metrics`,
        }),
        exportIntervalMillis: 10_000,
      }),
    ],
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
