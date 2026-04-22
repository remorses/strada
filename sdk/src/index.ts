/**
 * Default entry point for @strada.sh/sdk.
 *
 * In Node.js / Bun / Deno this re-exports the Node runtime implementation.
 * In browsers, bundlers resolve the "browser" condition in package.json
 * exports to browser.ts instead of this file.
 *
 * After initStrada(), standard OTel APIs work: trace.getTracer(),
 * logs.getLogger(), metrics.getMeter(). The SDK just configures them
 * correctly for Strada. captureException/track are optional sugar.
 *
 * Users who want explicit control can import from:
 * - "@strada.sh/sdk/node"
 * - "@strada.sh/sdk/browser"
 */

export {
  initStrada,
  captureException,
  flush,
  shutdown,
  setTags,
  type StradaOptions,
  type StradaTelemetryOptions,
  type CaptureExceptionOptions,
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
} from "./node.ts";
