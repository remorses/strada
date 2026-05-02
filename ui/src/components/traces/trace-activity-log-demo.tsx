/**
 * Demo page for the TraceActivityLog component. Uses the same OtelTraceRow
 * data format as trace-timeline-demo.tsx, fed through buildSpanTree().
 *
 * Shows multiple width variants and realistic OTel instrumentation data
 * including unknown span kinds, gRPC, messaging, and missing attributes.
 */
"use client"

import { useState, useMemo } from "react"
import type { OtelTraceRow } from "../../lib/utils.ts"
import { buildSpanTree } from "../../lib/utils.ts"
import { TraceActivityLog } from "./trace-activity-log.tsx"

// ─── Helpers ────────────────────────────────────────────────────

let traceCounter = 0
function makeRow(
  traceId: string,
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
  const baseNs = new Date("2025-03-21T10:19:00.000Z").getTime() * 1_000_000
  return {
    TraceId: traceId,
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

// ─── 1. User sign-up flow (narrow, matches original screenshot) ──

const SIGNUP_ROWS: OtelTraceRow[] = [
  makeRow("t1", "a01", "", "user: signed up", "google.com", "SPAN_KIND_SERVER", 0, 92000, "Ok", {
    "user.action": "sign_up",
    "user.email": "demo@example.com",
  }),
  makeRow("t1", "a02", "a01", "/sign-up", "google.com", "SPAN_KIND_SERVER", 1000, 85000, "Ok", {
    "http.route": "/sign-up", "http.method": "GET", "http.status_code": "200",
  }),
  makeRow("t1", "a03", "a02", "form.validate", "google.com", "SPAN_KIND_INTERNAL", 2000, 12000),
  makeRow("t1", "a04", "a02", "POST /api/register", "google.com", "SPAN_KIND_CLIENT", 15000, 45000, "Ok", {
    "http.method": "POST", "http.route": "/api/register", "http.status_code": "201",
  }),
  makeRow("t1", "a05", "a04", "INSERT INTO users", "postgres", "SPAN_KIND_CLIENT", 16000, 30000, "Ok", {
    "db.system": "postgresql", "db.statement": "INSERT INTO users (email, name) VALUES ($1, $2)",
  }),
  makeRow("t1", "a06", "a04", "send_welcome_email", "google.com", "SPAN_KIND_INTERNAL", 48000, 8000),
  makeRow("t1", "a07", "a01", "/", "google.com", "SPAN_KIND_SERVER", 30000, 32000, "Ok", {
    "http.route": "/", "http.method": "GET", "http.status_code": "200",
  }),
  makeRow("t1", "a08", "a07", "cache.get", "google.com", "SPAN_KIND_INTERNAL", 30500, 3000),
  makeRow("t1", "a09", "a01", "/blog/web-analytics", "google.com", "SPAN_KIND_SERVER", 50000, 45000, "Ok", {
    "http.route": "/blog/web-analytics", "http.method": "GET", "http.status_code": "200",
  }),
  makeRow("t1", "a10", "a09", "SELECT * FROM posts", "postgres", "SPAN_KIND_CLIENT", 51000, 20000, "Ok", {
    "db.system": "postgresql", "db.statement": "SELECT * FROM posts WHERE slug = $1",
  }),
  makeRow("t1", "a11", "a09", "render_markdown", "google.com", "SPAN_KIND_INTERNAL", 72000, 15000),
]

// ─── 2. Realistic Next.js SSR request (wide) ───────────────────

const NEXTJS_ROWS: OtelTraceRow[] = [
  makeRow("t2", "n01", "", "GET /dashboard/settings/billing", "next-app", "SPAN_KIND_SERVER", 0, 1850, "Ok", {
    "http.method": "GET", "http.route": "/dashboard/settings/billing",
    "http.status_code": "200", "next.route": "/dashboard/settings/billing",
    "next.rsc": "true",
  }),
  makeRow("t2", "n02", "n01", "middleware - /dashboard/*", "next-app", "SPAN_KIND_INTERNAL", 1, 12, "Ok", {
    "next.middleware.match": "/dashboard/*",
  }),
  makeRow("t2", "n03", "n01", "getSession", "next-app", "SPAN_KIND_INTERNAL", 15, 45, "Ok"),
  makeRow("t2", "n04", "n03", "SELECT * FROM sessions WHERE token = $1", "postgres", "SPAN_KIND_CLIENT", 18, 38, "Ok", {
    "db.system": "postgresql", "db.name": "app_production",
    "db.statement": "SELECT * FROM sessions WHERE token = $1 AND expires_at > NOW()",
  }),
  makeRow("t2", "n05", "n01", "fetchBillingData", "next-app", "SPAN_KIND_INTERNAL", 65, 980),
  makeRow("t2", "n06", "n05", "GET https://api.stripe.com/v1/subscriptions", "next-app", "SPAN_KIND_CLIENT", 70, 820, "Ok", {
    "http.method": "GET", "http.url": "https://api.stripe.com/v1/subscriptions?customer=cus_abc123",
    "http.status_code": "200", "peer.service": "stripe",
  }),
  makeRow("t2", "n07", "n05", "SELECT * FROM invoices WHERE org_id = $1 ORDER BY created_at DESC LIMIT 10", "postgres", "SPAN_KIND_CLIENT", 900, 120, "Ok", {
    "db.system": "postgresql", "db.statement": "SELECT * FROM invoices WHERE org_id = $1 ORDER BY created_at DESC LIMIT 10",
  }),
  makeRow("t2", "n08", "n01", "renderToReadableStream", "next-app", "SPAN_KIND_INTERNAL", 1050, 780),
  makeRow("t2", "n09", "n08", "BillingPage", "next-app", "SPAN_KIND_INTERNAL", 1055, 320),
  makeRow("t2", "n10", "n08", "InvoiceTable", "next-app", "SPAN_KIND_INTERNAL", 1380, 200),
  makeRow("t2", "n11", "n08", "UsageChart", "next-app", "SPAN_KIND_INTERNAL", 1600, 180),
]

// ─── 3. AI SDK / LLM agent trace (wide, deep nesting) ──────────

const AI_ROWS: OtelTraceRow[] = [
  makeRow("t3", "ai01", "", "ai.generateText", "my-agent", "SPAN_KIND_INTERNAL", 0, 14500, "Ok", {
    "ai.model.id": "gpt-4o", "ai.model.provider": "openai",
    "ai.prompt.messages": "[{role:'user',content:'Summarize this PR and suggest improvements'}]",
    "ai.response.finishReason": "stop",
    "ai.usage.promptTokens": "3842", "ai.usage.completionTokens": "1205",
  }),
  makeRow("t3", "ai02", "ai01", "ai.toolCall fetch_pr_diff", "my-agent", "SPAN_KIND_INTERNAL", 2100, 3200, "Ok", {
    "ai.toolCall.name": "fetch_pr_diff", "ai.toolCall.id": "call_abc123",
  }),
  makeRow("t3", "ai03", "ai02", "GET https://api.github.com/repos/acme/app/pulls/847/files", "my-agent", "SPAN_KIND_CLIENT", 2150, 2800, "Ok", {
    "http.method": "GET", "http.status_code": "200",
    "http.url": "https://api.github.com/repos/acme/app/pulls/847/files",
  }),
  makeRow("t3", "ai04", "ai01", "ai.toolCall read_file", "my-agent", "SPAN_KIND_INTERNAL", 5400, 1800, "Ok", {
    "ai.toolCall.name": "read_file", "ai.toolCall.id": "call_def456",
  }),
  makeRow("t3", "ai05", "ai04", "fs.readFile", "my-agent", "SPAN_KIND_INTERNAL", 5450, 25),
  makeRow("t3", "ai06", "ai01", "ai.toolCall run_tests", "my-agent", "SPAN_KIND_INTERNAL", 7300, 4200, "Ok", {
    "ai.toolCall.name": "run_tests", "ai.toolCall.id": "call_ghi789",
  }),
  makeRow("t3", "ai07", "ai06", "child_process.exec", "my-agent", "SPAN_KIND_INTERNAL", 7350, 4100, "Ok", {
    "process.command": "pnpm vitest run src/auth.test.ts",
  }),
  makeRow("t3", "ai08", "ai01", "POST https://api.openai.com/v1/chat/completions", "my-agent", "SPAN_KIND_CLIENT", 11600, 2850, "Ok", {
    "http.method": "POST", "http.url": "https://api.openai.com/v1/chat/completions",
    "http.status_code": "200", "gen_ai.system": "openai",
  }),
]

// ─── 4. Unknown/untyped spans, gRPC, messaging, missing data ───

const UNKNOWN_ROWS: OtelTraceRow[] = [
  // Root with UNSPECIFIED kind — totally unknown
  makeRow("t4", "u01", "", "process_batch_job_2847", "batch-worker", "SPAN_KIND_UNSPECIFIED", 0, 5200, "Ok"),
  // Child with empty kind string
  makeRow("t4", "u02", "u01", "step_1_validate", "batch-worker", "", 50, 800),
  // gRPC call
  makeRow("t4", "u03", "u01", "grpc.payment.v1.PaymentService/ChargeCard", "batch-worker", "SPAN_KIND_CLIENT", 900, 1200, "Ok", {
    "rpc.system": "grpc", "rpc.service": "payment.v1.PaymentService",
    "rpc.method": "ChargeCard", "rpc.grpc.status_code": "0",
  }),
  // Kafka producer
  makeRow("t4", "u04", "u01", "orders.completed send", "batch-worker", "SPAN_KIND_PRODUCER", 2200, 180, "Ok", {
    "messaging.system": "kafka", "messaging.destination.name": "orders.completed",
    "messaging.kafka.partition": "3",
  }),
  // Redis — no db.system, just the name hints at cache
  makeRow("t4", "u05", "u01", "HSET user:2847:prefs", "batch-worker", "SPAN_KIND_CLIENT", 2500, 15, "Ok", {
    "db.system": "redis", "db.statement": "HSET user:2847:prefs theme dark lang en",
  }),
  // Completely opaque span — no attributes at all, unknown kind
  makeRow("t4", "u06", "u01", "legacy_sync", "batch-worker", "SPAN_KIND_UNSPECIFIED", 2600, 1800),
  // Nested unknown children
  makeRow("t4", "u07", "u06", "xml_parse", "batch-worker", "", 2650, 400),
  makeRow("t4", "u08", "u06", "transform_records", "batch-worker", "", 3100, 900),
  makeRow("t4", "u09", "u08", "record_1..500", "batch-worker", "", 3150, 850),
  // Error span with no useful info
  makeRow("t4", "u10", "u01", "finalize", "batch-worker", "SPAN_KIND_UNSPECIFIED", 4500, 650, "Error"),
]

// ─── 5. E-commerce checkout (wide, realistic microservices) ─────

const CHECKOUT_ROWS: OtelTraceRow[] = [
  makeRow("t5", "c01", "", "POST /api/checkout", "storefront", "SPAN_KIND_SERVER", 0, 3400, "Ok", {
    "http.method": "POST", "http.route": "/api/checkout",
    "http.status_code": "200", "user.id": "usr_k8x92m",
  }),
  makeRow("t5", "c02", "c01", "validate_cart", "storefront", "SPAN_KIND_INTERNAL", 5, 120),
  makeRow("t5", "c03", "c02", "SELECT * FROM cart_items WHERE cart_id = $1", "postgres", "SPAN_KIND_CLIENT", 10, 65, "Ok", {
    "db.system": "postgresql", "db.statement": "SELECT ci.*, p.price, p.stock FROM cart_items ci JOIN products p ON ci.product_id = p.id WHERE ci.cart_id = $1",
  }),
  makeRow("t5", "c04", "c01", "reserve_inventory", "inventory-service", "SPAN_KIND_CLIENT", 130, 450, "Ok", {
    "http.method": "POST", "http.url": "http://inventory-service:8080/reserve",
    "http.status_code": "200",
  }),
  makeRow("t5", "c05", "c04", "POST /reserve", "inventory-service", "SPAN_KIND_SERVER", 135, 440),
  makeRow("t5", "c06", "c05", "UPDATE products SET stock = stock - $1 WHERE id = ANY($2)", "postgres", "SPAN_KIND_CLIENT", 140, 180, "Ok", {
    "db.system": "postgresql",
  }),
  makeRow("t5", "c07", "c05", "inventory.reserved publish", "inventory-service", "SPAN_KIND_PRODUCER", 330, 90, "Ok", {
    "messaging.system": "rabbitmq", "messaging.destination.name": "inventory.reserved",
  }),
  makeRow("t5", "c08", "c01", "charge_payment", "storefront", "SPAN_KIND_INTERNAL", 600, 1900),
  makeRow("t5", "c09", "c08", "POST https://api.stripe.com/v1/payment_intents", "storefront", "SPAN_KIND_CLIENT", 610, 1650, "Ok", {
    "http.method": "POST", "http.url": "https://api.stripe.com/v1/payment_intents",
    "http.status_code": "200", "peer.service": "stripe",
  }),
  makeRow("t5", "c10", "c08", "INSERT INTO payments (order_id, stripe_pi, amount) VALUES ($1, $2, $3)", "postgres", "SPAN_KIND_CLIENT", 2280, 95, "Ok", {
    "db.system": "postgresql",
  }),
  makeRow("t5", "c11", "c01", "send_confirmation", "storefront", "SPAN_KIND_INTERNAL", 2550, 800),
  makeRow("t5", "c12", "c11", "render_email_template", "storefront", "SPAN_KIND_INTERNAL", 2555, 120),
  makeRow("t5", "c13", "c11", "POST https://api.sendgrid.com/v3/mail/send", "storefront", "SPAN_KIND_CLIENT", 2700, 620, "Ok", {
    "http.method": "POST", "http.url": "https://api.sendgrid.com/v3/mail/send",
    "http.status_code": "202", "peer.service": "sendgrid",
  }),
]

// ─── 6. Cloudflare Worker with minimal spans ───────────────────

const CF_ROWS: OtelTraceRow[] = [
  makeRow("t6", "w01", "", "fetch", "my-worker", "SPAN_KIND_SERVER", 0, 85, "Ok", {
    "http.method": "GET", "http.url": "https://api.example.com/health",
    "http.status_code": "200", "faas.trigger": "http",
  }),
  makeRow("t6", "w02", "w01", "D1:query", "my-worker", "SPAN_KIND_CLIENT", 5, 22, "Ok", {
    "db.system": "d1", "db.statement": "SELECT 1",
  }),
  makeRow("t6", "w03", "w01", "KV:get config:flags", "my-worker", "SPAN_KIND_CLIENT", 30, 8),
]

// ─── Render ─────────────────────────────────────────────────────

function DemoSection({
  title,
  description,
  rows,
  maxWidth,
}: {
  title: string
  description: string
  rows: OtelTraceRow[]
  maxWidth: string
}) {
  const tree = useMemo(() => buildSpanTree(rows), [rows])
  const [selected, setSelected] = useState<string | undefined>()

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div style={{ maxWidth }}>
        <TraceActivityLog
          rootSpans={tree.rootSpans}
          totalDurationMs={tree.totalDurationMs}
          traceStartTime={tree.traceStartTime}
          services={tree.services}
          selectedSpanId={selected}
          onSelectSpan={(s) => setSelected(s.spanId)}
        />
      </div>
    </div>
  )
}

export function TraceActivityLogDemo() {
  return (
    <div className="flex flex-col gap-12 w-full">
      <DemoSection
        title="User sign-up flow"
        description="Narrow card (max-w-md). Page navigations with nested DB queries."
        rows={SIGNUP_ROWS}
        maxWidth="28rem"
      />

      <DemoSection
        title="Next.js SSR request"
        description="Wide card (max-w-2xl). Realistic server-side rendering with Stripe API call, DB queries, and React component spans."
        rows={NEXTJS_ROWS}
        maxWidth="42rem"
      />

      <DemoSection
        title="AI agent trace"
        description="Wide card (max-w-3xl). LLM generateText with tool calls, GitHub API, file reads, and test execution."
        rows={AI_ROWS}
        maxWidth="48rem"
      />

      <DemoSection
        title="Unknown & opaque spans"
        description="Fallback display for SPAN_KIND_UNSPECIFIED, empty kind strings, gRPC, Kafka, Redis, and spans with zero attributes."
        rows={UNKNOWN_ROWS}
        maxWidth="42rem"
      />

      <DemoSection
        title="E-commerce checkout"
        description="Full width. Microservice flow: cart validation, inventory reservation, Stripe payment, email confirmation."
        rows={CHECKOUT_ROWS}
        maxWidth="100%"
      />

      <DemoSection
        title="Cloudflare Worker"
        description="Narrow card (max-w-sm). Minimal 3-span Worker with D1 and KV."
        rows={CF_ROWS}
        maxWidth="24rem"
      />
    </div>
  )
}
