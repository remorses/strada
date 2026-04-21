// Extract exception data from OTel logs and traces into denormalized error rows.
//
// Two extraction paths:
// 1. Logs: log records with exception.type or exception.message in LogAttributes
// 2. Traces: span events where name === "exception" (OTel convention)
//
// Both paths also read custom error-tracking attributes:
//   exception.fingerprint, exception.mechanism.type, exception.mechanism.handled,
//   exception.structured_frames, exception.debug_id
//
// When no custom fingerprint is provided, the worker computes a default from
// exception type + top in-app frame function + stripped message pattern.

import type { ExportLogsServiceRequest, ExportTraceServiceRequest, KeyValue } from "./otlp-types.ts";
import type { OtelErrorRow } from "./otel-row-types.ts";
import { parseStackTrace } from "./parse-stacktrace.ts";
import { convertAttributes, getServiceName, nanosToRFC3339, anyValueToString } from "./transform-attributes.ts";

// ─── Public API ───

export function extractErrorsFromLogs(body: ExportLogsServiceRequest, tenantId: string): string {
  const rows: string[] = [];

  for (const rl of body.resourceLogs ?? []) {
    const resourceAttrs = convertAttributes(rl.resource?.attributes);
    const serviceName = getServiceName(rl.resource?.attributes);
    const release = getResourceAttr(rl.resource?.attributes, "service.version");
    const environment = getResourceAttr(rl.resource?.attributes, "deployment.environment.name");

    for (const sl of rl.scopeLogs ?? []) {
      const scopeAttrs = convertAttributes(sl.scope?.attributes);

      for (const log of sl.logRecords ?? []) {
        const attrs = convertAttributes(log.attributes);

        const exceptionType = attrs["exception.type"] ?? "";
        const exceptionMessage = attrs["exception.message"] ?? "";

        // Skip if no exception data
        if (!exceptionType && !exceptionMessage) continue;

        const timestamp =
          log.timeUnixNano && log.timeUnixNano !== "0" ? log.timeUnixNano : (log.observedTimeUnixNano ?? "0");

        const row = buildErrorRow({
          tenantId,
          timestamp: nanosToRFC3339(timestamp),
          traceId: log.traceId ?? "",
          spanId: log.spanId ?? "",
          serviceName,
          exceptionType,
          exceptionMessage,
          attrs,
          resourceAttrs,
          scopeAttrs,
          release,
          environment,
          sourceSignal: "log",
          ...(log.severityText !== undefined ? { severityText: log.severityText } : undefined),
        });

        rows.push(JSON.stringify(row));
      }
    }
  }

  return rows.length > 0 ? rows.join("\n") + "\n" : "";
}

export function extractErrorsFromTraces(body: ExportTraceServiceRequest, tenantId: string): string {
  const rows: string[] = [];

  for (const rs of body.resourceSpans ?? []) {
    const resourceAttrs = convertAttributes(rs.resource?.attributes);
    const serviceName = getServiceName(rs.resource?.attributes);
    const release = getResourceAttr(rs.resource?.attributes, "service.version");
    const environment = getResourceAttr(rs.resource?.attributes, "deployment.environment.name");

    for (const ss of rs.scopeSpans ?? []) {
      const scopeAttrs = convertAttributes(ss.scope?.attributes);

      for (const span of ss.spans ?? []) {
        for (const event of span.events ?? []) {
          // OTel convention: exception events have name "exception"
          if (event.name !== "exception") continue;

          const attrs = convertAttributes(event.attributes);
          const exceptionType = attrs["exception.type"] ?? "";
          const exceptionMessage = attrs["exception.message"] ?? "";

          if (!exceptionType && !exceptionMessage) continue;

          const row = buildErrorRow({
            tenantId,
            timestamp: nanosToRFC3339(event.timeUnixNano),
            traceId: span.traceId,
            spanId: span.spanId,
            serviceName,
            exceptionType,
            exceptionMessage,
            attrs,
            resourceAttrs,
            scopeAttrs,
            release,
            environment,
            sourceSignal: "trace",
          });

          rows.push(JSON.stringify(row));
        }
      }
    }
  }

  return rows.length > 0 ? rows.join("\n") + "\n" : "";
}

// ─── Fingerprint computation ───

/**
 * Strip dynamic values from exception messages so that errors differing only
 * in numbers, hex strings, or UUIDs get grouped together.
 *
 * "Connection refused to 192.168.1.42:5432" → "Connection refused to <N>.<N>.<N>.<N>:<N>"
 * "User abc123def not found" → "User <hex> not found"
 * "Request 550e8400-e29b-41d4-a716-446655440000 failed" → "Request <uuid> failed"
 */
export function stripDynamicValues(message: string): string {
  return (
    message
      // UUIDs first (before hex, since UUIDs contain hex)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
      // Hex prefixed strings (0x...)
      .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
      // Numbers — before bare hex so "192.168.1.42" becomes "<N>.<N>.<N>.<N>"
      .replace(/\b\d+\b/g, "<N>")
      // Remaining bare hex strings (8+ chars, only after numbers are replaced)
      .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
  );
}

interface StructuredFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  abs_path?: string;
  in_app?: boolean;
  debug_id?: string;
}

/**
 * Compute a default fingerprint when the SDK doesn't provide one.
 *
 * Priority:
 * 1. If structured frames have in_app frames → [type, top_in_app_function]
 * 2. If no structured frames → [type, stripped_message]
 * 3. If neither type nor message → ["unknown"]
 */
export function computeDefaultFingerprint(
  exceptionType: string,
  exceptionMessage: string,
  structuredFramesJson: string,
): string[] {
  // Try structured frames first
  if (structuredFramesJson) {
    try {
      const frames: StructuredFrame[] = JSON.parse(structuredFramesJson);
      const inAppFrames = frames.filter((f) => f.in_app === true);
      if (inAppFrames.length > 0) {
        const topFrame = inAppFrames[inAppFrames.length - 1]!;
        const fn = topFrame.function || topFrame.filename || "<anonymous>";
        return exceptionType ? [exceptionType, fn] : [fn];
      }
    } catch {
      // Invalid JSON, fall through
    }
  }

  // Fall back to type + stripped message
  if (exceptionType && exceptionMessage) {
    return [exceptionType, stripDynamicValues(exceptionMessage)];
  }
  if (exceptionType) {
    return [exceptionType];
  }
  if (exceptionMessage) {
    return [stripDynamicValues(exceptionMessage)];
  }

  return ["unknown"];
}

/**
 * Hash a fingerprint array into a 32-character hex string.
 * Uses a simple FNV-1a-like hash since crypto.subtle is async
 * and we want this to be synchronous and fast.
 */
export function hashFingerprint(fingerprint: string[]): string {
  const input = fingerprint.join("\x00");
  // FNV-1a 128-bit (two 64-bit halves using regular numbers for speed)
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  let h3 = 0x811c9dc5;
  let h4 = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c + 1), 0x01000193);
    h3 = Math.imul(h3 ^ (c + 2), 0x01000193);
    h4 = Math.imul(h4 ^ (c + 3), 0x01000193);
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, "0") +
    (h2 >>> 0).toString(16).padStart(8, "0") +
    (h3 >>> 0).toString(16).padStart(8, "0") +
    (h4 >>> 0).toString(16).padStart(8, "0")
  );
}

// ─── Internal helpers ───

function getResourceAttr(kvs: KeyValue[] | undefined, key: string): string {
  if (!kvs) return "";
  const attr = kvs.find((kv) => kv.key === key);
  return attr ? anyValueToString(attr.value) : "";
}

interface BuildErrorRowParams {
  tenantId: string;
  timestamp: string;
  traceId: string;
  spanId: string;
  serviceName: string;
  exceptionType: string;
  exceptionMessage: string;
  attrs: Record<string, string>;
  resourceAttrs: Record<string, string>;
  scopeAttrs: Record<string, string>;
  release: string;
  environment: string;
  sourceSignal: "log" | "trace";
  severityText?: string;
}

function buildErrorRow(params: BuildErrorRowParams): OtelErrorRow {
  const {
    tenantId,
    timestamp,
    traceId,
    spanId,
    serviceName,
    exceptionType,
    exceptionMessage,
    attrs,
    resourceAttrs,
    scopeAttrs,
    release,
    environment,
    sourceSignal,
    severityText,
  } = params;

  // Read custom error-tracking attributes
  const stacktrace = attrs["exception.stacktrace"] ?? "";
  let structuredFrames = attrs["exception.structured_frames"] ?? "";
  if (!structuredFrames && stacktrace) {
    const parsed = parseStackTrace(stacktrace);
    if (parsed.frames.length > 0) {
      structuredFrames = JSON.stringify(parsed.frames);
    }
  }
  const mechanismType = attrs["exception.mechanism.type"] ?? "generic";
  const mechanismHandled = attrs["exception.mechanism.handled"] !== "false";
  const debugId = attrs["exception.debug_id"] ?? "";

  // Fingerprint: use SDK-provided or compute default
  let fingerprint: string[];
  const fingerprintAttr = attrs["exception.fingerprint"];
  if (fingerprintAttr) {
    try {
      fingerprint = JSON.parse(fingerprintAttr);
    } catch {
      fingerprint = [fingerprintAttr];
    }
  } else {
    fingerprint = computeDefaultFingerprint(exceptionType, exceptionMessage, structuredFrames);
  }

  const fingerprintHash = hashFingerprint(fingerprint);

  // Level: use custom attribute or derive from severity
  const level = attrs["exception.level"] || severityText?.toLowerCase() || "error";

  // Tags: everything in the attrs that isn't an exception.* attribute
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!k.startsWith("exception.")) {
      tags[k] = v;
    }
  }

  return {
    tenant_id: tenantId,
    timestamp,
    trace_id: traceId,
    span_id: spanId,
    service_name: serviceName,
    exception_type: exceptionType,
    exception_message: exceptionMessage,
    exception_stacktrace: stacktrace,
    exception_frames: structuredFrames,
    fingerprint,
    fingerprint_hash: fingerprintHash,
    mechanism_type: mechanismType,
    mechanism_handled: mechanismHandled,
    debug_id: debugId,
    level,
    release,
    environment,
    tags,
    resource_attributes: resourceAttrs,
    scope_attributes: scopeAttrs,
    source_signal: sourceSignal,
  };
}
