/**
 * Node.js runtime entry for @strada.sh/sdk.
 *
 * Wraps @opentelemetry/sdk-node with Strada conventions: auto-instrumentation,
 * global error handlers, captureException, and user/tag context. Everything
 * flows through standard OTel; no custom transport or protocol.
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
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
  ERROR_SEVERITY,
  ERROR_SEVERITY_TEXT,
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
// Module state
// ---------------------------------------------------------------------------

let _sdk: NodeSDK | undefined;
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
 * - OTel NodeSDK with trace, metric, and log exporters
 * - Auto-instrumentation (http, express, pg, mysql, redis, etc.)
 * - Global uncaughtException / unhandledRejection handlers
 * - captureException() for manual error reporting
 */
export function initStrada(options: StradaOptions): void {
  if (_sdk) {
    console.warn(
      "[@strada.sh/sdk] initStrada() was already called. Ignoring duplicate init.",
    );
    return;
  }

  _options = options;

  const resource = resourceFromAttributes({
    "service.name": options.service,
    ...(options.version ? { "service.version": options.version } : {}),
    ...(options.environment
      ? { "deployment.environment.name": options.environment }
      : {}),
  });

  const endpoint = options.endpoint.replace(/\/+$/, "");

  // Log provider (used for both logs and error capture)
  const logExporter = new OTLPLogExporter({
    url: `${endpoint}/v1/logs`,
  });
  _loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor(logExporter)],
  });
  logs.setGlobalLoggerProvider(_loggerProvider);
  _logger = _loggerProvider.getLogger("strada");

  // NodeSDK (traces + metrics + auto-instrumentation)
  const sdkConfig: ConstructorParameters<typeof NodeSDK>[0] = {
    resource,
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
    }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${endpoint}/v1/metrics`,
      }),
      exportIntervalMillis: 10_000,
    }),
  };

  // Try to load auto-instrumentations (optional peer dep)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@opentelemetry/auto-instrumentations-node");
    if (mod && typeof mod.getNodeAutoInstrumentations === "function") {
      sdkConfig.instrumentations = mod.getNodeAutoInstrumentations();
    }
  } catch {
    // auto-instrumentations-node not installed, that's fine
    if (options.debug) {
      console.log(
        "[@strada.sh/sdk] @opentelemetry/auto-instrumentations-node not found, skipping auto-instrumentation",
      );
    }
  }

  _sdk = new NodeSDK(sdkConfig);

  _sdk.start();

  // Global error handlers
  process.on("uncaughtException", (error) => {
    captureException(error, { handled: false });
    _loggerProvider
      ?.forceFlush()
      .catch(() => {})
      .finally(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    const error = normalizeError(reason);
    captureException(error, { handled: false });
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
  if (_options?.beforeSend) {
    const result = _options.beforeSend(normalized);
    if (result === null) return;
  }

  const attributes = errorToAttributes(normalized, opts);

  if (_logger) {
    _logger.emit({
      severityNumber: ERROR_SEVERITY,
      severityText: ERROR_SEVERITY_TEXT,
      body: normalized.message,
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
  await _loggerProvider?.forceFlush();
}

/**
 * Shut down the SDK and flush remaining telemetry.
 */
export async function shutdown(): Promise<void> {
  await _sdk?.shutdown();
  await _loggerProvider?.shutdown();
  _sdk = undefined;
  _loggerProvider = undefined;
  _logger = undefined;
  _options = undefined;
  resetContext();
}
