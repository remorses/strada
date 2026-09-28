/**
 * Public API shared by every runtime entry (node, browser, cloudflare):
 * captureException, track, getLogger, flush, shutdown, and re-exports of the
 * OTel-shaped API. Entries `export *` this file and add initStrada plus
 * runtime-specific functions.
 */

import { logs } from "./api.ts";
import { ATTR } from "./attrs.ts";
import { flush as flushPipeline, stopPipeline } from "./export.ts";
import {
  createStradaLogger,
  ERROR_SEVERITY,
  ERROR_SEVERITY_TEXT,
  errorToAttributes,
  getOptions,
  INFO_SEVERITY,
  INFO_SEVERITY_TEXT,
  isInitialized,
  prepareErrorForCapture,
  recordExceptionOnSpan,
  resetOptions,
  teardownIntegrations,
  tryTelemetry,
  tryTelemetryAsync,
  type CaptureExceptionOptions,
  type StradaLogger,
} from "./shared.ts";

function warnBeforeInit(what: string): boolean {
  if (isInitialized()) return false;
  console.warn(`[@strada.sh/sdk] ${what} called before initStrada(). Nothing was sent.`);
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Capture an exception and send it to Strada as a log record. The collector
 * extracts exception.* attributes into otel_errors for issue grouping.
 */
export function captureException(error: unknown, opts?: CaptureExceptionOptions): Error | undefined {
  return tryTelemetry({
    operation: "captureException()",
    run: () => {
      const prepared = prepareErrorForCapture(error, getOptions());
      if (prepared === null) return;
      const attributes = errorToAttributes(prepared, opts);
      if (opts?.handled === false) recordExceptionOnSpan(prepared);
      if (warnBeforeInit("captureException()")) return;
      logs.getLogger("strada").emit({
        eventName: "exception",
        severityNumber: ERROR_SEVERITY,
        severityText: ERROR_SEVERITY_TEXT,
        body: prepared.message,
        attributes,
      });
    },
  });
}

/** Product analytics event. Properties are stored as `custom.*` attributes. */
export function track(name: string, properties?: Record<string, string | number | boolean>): Error | undefined {
  return tryTelemetry({
    operation: "track()",
    run: () => {
      if (warnBeforeInit("track()")) return;
      const custom = Object.fromEntries(Object.entries(properties ?? {}).map(([key, value]) => [`custom.${key}`, value]));
      logs.getLogger("strada").emit({
        eventName: name,
        severityNumber: INFO_SEVERITY,
        severityText: INFO_SEVERITY_TEXT,
        body: name,
        attributes: { [ATTR["event.name"]]: name, ...custom },
      });
    },
  });
}

export function getLogger(name = "strada"): StradaLogger {
  return createStradaLogger((loggerName) => (isInitialized() ? logs.getLogger(loggerName) : undefined), undefined, name);
}

/** Send all buffered telemetry. Call before a short-lived process exits. */
export function flush(): Promise<Error | undefined> {
  return tryTelemetryAsync({
    operation: "flush()",
    run: async () => {
      const error = await flushPipeline();
      if (error) throw error;
    },
  });
}

/** Remove integrations, flush, then stop exporting. `initStrada()` can be called again afterwards. */
export async function shutdown(): Promise<Error | undefined> {
  teardownIntegrations();
  const error = await flush();
  stopPipeline();
  resetOptions();
  return error;
}

// ---------------------------------------------------------------------------
// Re-exports shared by every runtime entry
// ---------------------------------------------------------------------------

export {
  trace,
  context,
  propagation,
  logs,
  metrics,
  SpanStatusCode,
  SpanKind,
  SeverityNumber,
  TraceFlags,
  ROOT_CONTEXT,
  createContextKey,
  createTraceState,
  isSpanContextValid,
  defaultTextMapGetter,
  defaultTextMapSetter,
  type Attributes,
  type AttributeValue,
  type Baggage,
  type BaggageEntry,
  type Context,
  type Counter,
  type Gauge,
  type Histogram,
  type Link,
  type Logger,
  type LogRecord,
  type Meter,
  type MetricOptions,
  type Observable,
  type ObservableResult,
  type Span,
  type SpanAttributes,
  type SpanAttributeValue,
  type SpanContext,
  type SpanOptions,
  type SpanStatus,
  type TextMapGetter,
  type TextMapSetter,
  type TimeInput,
  type TraceState,
  type Tracer,
  type UpDownCounter,
} from "./api.ts";
export type { BatchOptions, MetricExportOptions } from "./export.ts";
export {
  ATTR,
  setTags,
  startSpan,
  startInactiveSpan,
  type CaptureExceptionOptions,
  type DisposableSpan,
  type StartSpanOptions,
  type StradaIntegration,
  type StradaLogger,
  type StradaOptions,
  type StradaTelemetryOptions,
  type StradaUserIdentity,
  type TrackPageviewOptions,
} from "./shared.ts";
