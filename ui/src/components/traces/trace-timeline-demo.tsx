/**
 * Demo page that feeds flat OTel trace rows (matching the DB schema)
 * through buildSpanTree() to produce the SpanNode tree the timeline needs.
 */
"use client"

import { useState, useMemo } from "react"
import type { SpanNode, OtelTraceRow } from "../../lib/utils.ts"
import { formatDuration, getServiceLegendColor, buildSpanTree } from "../../lib/utils.ts"
import { TraceTimeline } from "./trace-timeline.tsx"

// ─── Demo data in the OTel DB row format (PascalCase, Duration in nanoseconds) ──

const BASE = "2025-01-15T10:30:00.000000000Z"
const baseNs = new Date(BASE).getTime() * 1_000_000

function row(
  spanId: string, parentSpanId: string, name: string, service: string,
  kind: string, offsetMs: number, durationMs: number,
  status = "Ok", attrs: Record<string, string> = {},
): OtelTraceRow {
  return {
    TraceId: "abc123def456789012345678",
    SpanId: spanId,
    ParentSpanId: parentSpanId,
    SpanName: name,
    ServiceName: service,
    SpanKind: kind,
    Duration: durationMs * 1_000_000,
    Timestamp: new Date((baseNs + offsetMs * 1_000_000) / 1_000_000).toISOString(),
    StatusCode: status,
    StatusMessage: status === "Error" ? "Internal server error" : "",
    SpanAttributes: attrs,
    ResourceAttributes: {},
  }
}

// Flat array — exactly what SELECT * FROM otel_traces WHERE TraceId = '...' returns
const DEMO_ROWS: OtelTraceRow[] = [
  row("s01", "",    "GET /api/users/42",    "api-gateway",       "SPAN_KIND_SERVER",   0,   320, "Ok", { "http.method": "GET", "http.route": "/api/users/:id", "http.status_code": "200" }),
  row("s02", "s01", "authenticate",         "api-gateway",       "SPAN_KIND_INTERNAL", 2,   15),
  row("s03", "s01", "GET /users/42",        "user-service",      "SPAN_KIND_CLIENT",   20,  250, "Ok", { "http.method": "GET", "http.route": "/users/:id", "http.status_code": "200" }),
  row("s04", "s03", "GET /users/42",        "user-service",      "SPAN_KIND_SERVER",   22,  245),
  row("s05", "s04", "cache.get",            "user-service",      "SPAN_KIND_INTERNAL", 24,  3),
  row("s06", "s04", "SELECT * FROM users",  "postgres",          "SPAN_KIND_CLIENT",   30,  85,  "Ok", { "db.system": "postgresql", "db.statement": "SELECT * FROM users WHERE id = $1" }),
  row("s07", "s06", "db.query",             "postgres",          "SPAN_KIND_SERVER",   32,  80),
  row("s08", "s04", "SELECT * FROM prefs",  "postgres",          "SPAN_KIND_CLIENT",   120, 45),
  row("s09", "s08", "db.query",             "postgres",          "SPAN_KIND_SERVER",   122, 40),
  row("s10", "s04", "cache.set",            "user-service",      "SPAN_KIND_INTERNAL", 170, 5),
  row("s11", "s04", "serialize_response",   "user-service",      "SPAN_KIND_INTERNAL", 180, 12),
  row("s12", "s01", "POST /analytics",      "analytics-service", "SPAN_KIND_CLIENT",   275, 35,  "Ok", { "http.method": "POST", "http.route": "/analytics/event", "http.status_code": "202" }),
  row("s13", "s12", "POST /analytics",      "analytics-service", "SPAN_KIND_SERVER",   278, 30),
  row("s14", "s13", "kafka.produce",        "analytics-service", "SPAN_KIND_PRODUCER", 280, 18),
  row("s15", "s01", "log_request",          "api-gateway",       "SPAN_KIND_INTERNAL", 312, 5),
]

export function TraceTimelineDemo() {
  const { rootSpans, totalDurationMs, traceStartTime, services } = useMemo(
    () => buildSpanTree(DEMO_ROWS),
    []
  )

  const [selectedSpanId, setSelectedSpanId] = useState<string | undefined>(undefined)
  const selectedSpan = selectedSpanId ? findSpan(rootSpans, selectedSpanId) : null

  return (
    <div className="flex flex-col gap-4 w-full">
      <div className="h-[600px] w-full">
        <TraceTimeline
          rootSpans={rootSpans}
          totalDurationMs={totalDurationMs}
          traceStartTime={traceStartTime}
          services={services}
          selectedSpanId={selectedSpanId}
          onSelectSpan={(s) => setSelectedSpanId(s.spanId)}
        />
      </div>

      {selectedSpan && (
        <div className="border border-border rounded-lg p-4 bg-card text-card-foreground flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded-sm" style={{ backgroundColor: getServiceLegendColor(selectedSpan.serviceName, services) }} />
              <span className="font-mono text-sm font-semibold">{selectedSpan.spanName}</span>
            </div>
            <button onClick={() => setSelectedSpanId(undefined)} className="text-muted-foreground hover:text-foreground text-xs">
              Close
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
            <div>
              <span className="text-muted-foreground block">Service</span>
              <span className="font-medium">{selectedSpan.serviceName}</span>
            </div>
            <div>
              <span className="text-muted-foreground block">Duration</span>
              <span className="font-mono font-medium">{formatDuration(selectedSpan.durationMs)}</span>
            </div>
            <div>
              <span className="text-muted-foreground block">Status</span>
              <span className={selectedSpan.statusCode === "Error" ? "text-destructive font-medium" : "font-medium"}>
                {selectedSpan.statusCode}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground block">Span ID</span>
              <span className="font-mono text-muted-foreground">{selectedSpan.spanId}</span>
            </div>
          </div>
          {Object.keys(selectedSpan.spanAttributes).length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs block">Attributes</span>
              <div className="flex flex-wrap gap-1">
                {Object.entries(selectedSpan.spanAttributes).map(([k, v]) => (
                  <span key={k} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-muted text-[10px] font-mono">
                    <span className="text-muted-foreground">{k}:</span>
                    <span>{v}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function findSpan(spans: SpanNode[], id: string): SpanNode | null {
  for (const s of spans) {
    if (s.spanId === id) return s
    const found = findSpan(s.children, id)
    if (found) return found
  }
  return null
}
