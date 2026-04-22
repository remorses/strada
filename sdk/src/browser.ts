/**
 * Browser runtime entry for @strada.sh/sdk.
 *
 * Wraps @opentelemetry/sdk-trace-web and sdk-logs with Strada conventions:
 * web auto-instrumentation (fetch, XHR, document load, user interaction),
 * global error handlers, browser junk filtering, and captureException.
 * Everything flows through standard OTel OTLP HTTP/JSON.
 */

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

// Re-export shared types and helpers so users only need one import
export {
  type StradaOptions,
  type CaptureExceptionOptions,
  type UserContext,
  setUser,
  setTags,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// Filtering log processor
// ---------------------------------------------------------------------------

/**
 * Wraps another LogRecordProcessor and drops log records that match
 * browser noise patterns (Script error, ResizeObserver, extensions).
 * This catches errors from both captureException() and any OTel
 * instrumentation that emits log records.
 */
class FilteringLogProcessor implements LogRecordProcessor {
  constructor(private readonly inner: LogRecordProcessor) {}

  onEmit(...args: Parameters<LogRecordProcessor["onEmit"]>): void {
    const record = args[0];
    const message = String(
      record.attributes?.["exception.message"] ?? "",
    );
    const stack = String(
      record.attributes?.["exception.stacktrace"] ?? "",
    );

    // Drop known browser noise at the processor level as a safety net
    if (message === "Script error." || message === "Script error") return;
    if (message.includes("ResizeObserver loop limit exceeded")) return;
    if (
      message.includes(
        "ResizeObserver loop completed with undelivered notifications",
      )
    )
      return;
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
// Module state
// ---------------------------------------------------------------------------

let _tracerProvider: WebTracerProvider | undefined;
let _loggerProvider: LoggerProvider | undefined;
let _logger: Logger | undefined;
let _options: StradaOptions | undefined;
let _errorListener: ((event: ErrorEvent) => void) | undefined;
let _rejectionListener:
  | ((event: PromiseRejectionEvent) => void)
  | undefined;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Initialize Strada for the browser. Call this once at app startup,
 * before rendering your app.
 *
 * This sets up:
 * - OTel WebTracerProvider with OTLP trace exporter
 * - OTel LoggerProvider with filtering + OTLP log exporter
 * - Web auto-instrumentation (fetch, XHR, document load, user interaction)
 * - Global window.error / unhandledrejection handlers
 * - Browser junk filtering (Script error, extensions, ResizeObserver)
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

  const resource = resourceFromAttributes({
    "service.name": options.service,
    ...(options.version ? { "service.version": options.version } : {}),
    ...(options.environment
      ? { "deployment.environment.name": options.environment }
      : {}),
  });

  const endpoint = options.endpoint.replace(/\/+$/, "");

  // Tracer provider
  _tracerProvider = new WebTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      ),
    ],
  });
  _tracerProvider.register();

  // Logger provider with filtering
  const logExporter = new OTLPLogExporter({
    url: `${endpoint}/v1/logs`,
  });
  _loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new FilteringLogProcessor(
        new BatchLogRecordProcessor(logExporter),
      ),
    ],
  });
  logs.setGlobalLoggerProvider(_loggerProvider);
  _logger = _loggerProvider.getLogger("strada-web");

  // Try to load web auto-instrumentations (optional peer dep).
  // Use dynamic import so the bundler can tree-shake it when not installed.
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
        console.log(
          "[@strada.sh/sdk] @opentelemetry/auto-instrumentations-web not found, skipping",
        );
      }
    });

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
  await _tracerProvider?.shutdown();
  await _loggerProvider?.shutdown();
  _tracerProvider = undefined;
  _loggerProvider = undefined;
  _logger = undefined;
  _options = undefined;
  resetContext();
}
