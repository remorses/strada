/**
 * Demo page for the TraceActivityLog component. Uses the same OtelTraceRow
 * data format as trace-timeline-demo.tsx, fed through buildSpanTree().
 */
"use client"

import { useState, useMemo } from "react"
import type { SpanNode, OtelTraceRow } from "../../lib/utils.ts"
import { buildSpanTree, formatDuration } from "../../lib/utils.ts"
import { TraceActivityLog } from "./trace-activity-log.tsx"

// ─── Demo data ──────────────────────────────────────────────────

const BASE = "2025-03-21T10:19:00.000000000Z"
const baseNs = new Date(BASE).getTime() * 1_000_000

function row(
  spanId: string,
  parentSpanId: string,
  name: string,
  service: string,
  kind: string,
  offsetMs: number,
  durationMs: number,
  status = "Ok",
  attrs: Record<string, string> = {},
): OtelTraceRow {
  return {
    TraceId: "trace-activity-demo-001",
    SpanId: spanId,
    ParentSpanId: parentSpanId,
    SpanName: name,
    ServiceName: service,
    SpanKind: kind,
    Duration: durationMs * 1_000_000,
    Timestamp: new Date(
      (baseNs + offsetMs * 1_000_000) / 1_000_000,
    ).toISOString(),
    StatusCode: status,
    StatusMessage: status === "Error" ? "Internal server error" : "",
    SpanAttributes: attrs,
    ResourceAttributes: {},
  }
}

// Mimics the screenshot: user signed up flow with page navigations
const DEMO_ROWS: OtelTraceRow[] = [
  // Root: user sign-up event
  row("a01", "", "user: signed up", "google.com", "SPAN_KIND_SERVER", 0, 92000, "Ok", {
    "user.action": "sign_up",
    "user.email": "demo@example.com",
  }),
  // Page navigations as children
  row("a02", "a01", "/sign-up", "google.com", "SPAN_KIND_SERVER", 1000, 85000, "Ok", {
    "http.route": "/sign-up",
    "http.method": "GET",
    "http.status_code": "200",
  }),
  row("a03", "a02", "form.validate", "google.com", "SPAN_KIND_INTERNAL", 2000, 12000),
  row("a04", "a02", "POST /api/register", "google.com", "SPAN_KIND_CLIENT", 15000, 45000, "Ok", {
    "http.method": "POST",
    "http.route": "/api/register",
    "http.status_code": "201",
  }),
  row("a05", "a04", "INSERT INTO users", "postgres", "SPAN_KIND_CLIENT", 16000, 30000, "Ok", {
    "db.system": "postgresql",
    "db.statement": "INSERT INTO users (email, name) VALUES ($1, $2)",
  }),
  row("a06", "a04", "send_welcome_email", "google.com", "SPAN_KIND_INTERNAL", 48000, 8000),
  row("a07", "a01", "/", "google.com", "SPAN_KIND_SERVER", 30000, 32000, "Ok", {
    "http.route": "/",
    "http.method": "GET",
    "http.status_code": "200",
  }),
  row("a08", "a07", "cache.get", "google.com", "SPAN_KIND_INTERNAL", 30500, 3000),
  row("a09", "a01", "/blog/web-analytics", "google.com", "SPAN_KIND_SERVER", 50000, 45000, "Ok", {
    "http.route": "/blog/web-analytics",
    "http.method": "GET",
    "http.status_code": "200",
  }),
  row("a10", "a09", "SELECT * FROM posts", "postgres", "SPAN_KIND_CLIENT", 51000, 20000, "Ok", {
    "db.system": "postgresql",
    "db.statement": "SELECT * FROM posts WHERE slug = $1",
  }),
  row("a11", "a09", "render_markdown", "google.com", "SPAN_KIND_INTERNAL", 72000, 15000),
]

// Second trace — a simpler API call with an error
const DEMO_ROWS_2: OtelTraceRow[] = [
  row("b01", "", "GET /api/users/42", "api-gateway", "SPAN_KIND_SERVER", 0, 320, "Ok", {
    "http.method": "GET",
    "http.route": "/api/users/:id",
    "http.status_code": "200",
  }),
  row("b02", "b01", "authenticate", "api-gateway", "SPAN_KIND_INTERNAL", 2, 15),
  row("b03", "b01", "GET /users/42", "user-service", "SPAN_KIND_CLIENT", 20, 250, "Ok", {
    "http.method": "GET",
    "http.route": "/users/:id",
  }),
  row("b04", "b03", "SELECT * FROM users", "postgres", "SPAN_KIND_CLIENT", 30, 85, "Ok", {
    "db.system": "postgresql",
    "db.statement": "SELECT * FROM users WHERE id = $1",
  }),
  row("b05", "b03", "cache.set", "user-service", "SPAN_KIND_INTERNAL", 170, 5),
  row("b06", "b01", "POST /analytics", "analytics-service", "SPAN_KIND_CLIENT", 275, 35, "Error", {
    "http.method": "POST",
    "http.route": "/analytics/event",
    "http.status_code": "500",
  }),
]

export function TraceActivityLogDemo() {
  const trace1 = useMemo(() => buildSpanTree(DEMO_ROWS), [])
  const trace2 = useMemo(() => buildSpanTree(DEMO_ROWS_2), [])
  const [selected1, setSelected1] = useState<string | undefined>()
  const [selected2, setSelected2] = useState<string | undefined>()

  return (
    <div className="flex flex-col gap-8 w-full max-w-md">
      <TraceActivityLog
        rootSpans={trace1.rootSpans}
        totalDurationMs={trace1.totalDurationMs}
        traceStartTime={trace1.traceStartTime}
        services={trace1.services}
        selectedSpanId={selected1}
        onSelectSpan={(s) => setSelected1(s.spanId)}
      />

      <TraceActivityLog
        rootSpans={trace2.rootSpans}
        totalDurationMs={trace2.totalDurationMs}
        traceStartTime={trace2.traceStartTime}
        services={trace2.services}
        selectedSpanId={selected2}
        onSelectSpan={(s) => setSelected2(s.spanId)}
      />
    </div>
  )
}
