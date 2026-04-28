// Traces CLI commands. Lists trace summaries and renders a single trace as a
// span tree using a data shape intentionally close to trace-view's UI types.

import { goke } from "goke";
import dedent from "string-dedent";
import { z } from "zod";
import { bold, cyan, dim, gray, green, red, yellow } from "./colors.ts";
import { ensureDefaultOrg, resolveProjectId } from "./projects.ts";
import { queryProject } from "./issues.ts";
import { printTable, formatCount, timeAgo } from "./table.ts";
import { parseTimeBoundary } from "./parse-duration.ts";

export const tracesCli = goke();

type QueryRow = Record<string, unknown>;

interface OtelTraceRow {
  TraceId: string;
  SpanId: string;
  ParentSpanId: string;
  SpanName: string;
  ServiceName: string;
  SpanKind: string;
  /** Nanoseconds */
  Duration: number;
  /** DateTime64(9) from ClickHouse/Tinybird JSON response */
  Timestamp: string;
  StatusCode: string;
  StatusMessage: string;
  SpanAttributes: Record<string, string>;
  ResourceAttributes: Record<string, string>;
}

interface SpanNode {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  spanName: string;
  serviceName: string;
  spanKind: string;
  durationMs: number;
  startTime: string;
  statusCode: string;
  statusMessage: string;
  spanAttributes: Record<string, string>;
  resourceAttributes: Record<string, string>;
  children: SpanNode[];
  depth: number;
  isMissing?: boolean;
}

interface TraceViewData {
  traceId: string;
  rootSpans: SpanNode[];
  totalDurationMs: number;
  traceStartTime: string;
  services: string[];
}

function str(row: QueryRow, key: string): string {
  const value = row[key];
  if (value == null) return "";
  return String(value);
}

function num(row: QueryRow, key: string): number {
  return Number(row[key] ?? 0) || 0;
}

function parseAttributes(value: unknown): Record<string, string> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, string>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch (error) {
    console.error(`Failed to parse trace attributes: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function toTraceRow(row: QueryRow): OtelTraceRow {
  return {
    TraceId: str(row, "TraceId"),
    SpanId: str(row, "SpanId"),
    ParentSpanId: str(row, "ParentSpanId"),
    SpanName: str(row, "SpanName"),
    ServiceName: str(row, "ServiceName"),
    SpanKind: str(row, "SpanKind"),
    Duration: num(row, "Duration"),
    Timestamp: str(row, "Timestamp"),
    StatusCode: str(row, "StatusCode"),
    StatusMessage: str(row, "StatusMessage"),
    SpanAttributes: parseAttributes(row.SpanAttributes),
    ResourceAttributes: parseAttributes(row.ResourceAttributes),
  };
}

function buildSpanTree(rows: OtelTraceRow[]): TraceViewData {
  const byId = new Map<string, SpanNode>();

  for (const row of rows) {
    byId.set(row.SpanId, {
      traceId: row.TraceId,
      spanId: row.SpanId,
      parentSpanId: row.ParentSpanId,
      spanName: row.SpanName,
      serviceName: row.ServiceName,
      spanKind: row.SpanKind,
      durationMs: row.Duration / 1_000_000,
      startTime: row.Timestamp,
      statusCode: row.StatusCode,
      statusMessage: row.StatusMessage,
      spanAttributes: row.SpanAttributes,
      resourceAttributes: row.ResourceAttributes,
      children: [],
      depth: 0,
    });
  }

  const rootSpans: SpanNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentSpanId ? byId.get(node.parentSpanId) : undefined;
    if (parent) parent.children.push(node);
    else rootSpans.push(node);
  }

  function setDepth(node: SpanNode, depth: number) {
    node.depth = depth;
    node.children.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    for (const child of node.children) setDepth(child, depth + 1);
  }
  for (const root of rootSpans) setDepth(root, 0);
  rootSpans.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

  let traceStartMs = Infinity;
  let traceEndMs = -Infinity;
  const services = new Set<string>();
  for (const row of rows) {
    const startMs = new Date(row.Timestamp).getTime();
    const endMs = startMs + row.Duration / 1_000_000;
    if (startMs < traceStartMs) traceStartMs = startMs;
    if (endMs > traceEndMs) traceEndMs = endMs;
    if (row.ServiceName) services.add(row.ServiceName);
  }

  return {
    traceId: rows[0]?.TraceId ?? "",
    rootSpans,
    totalDurationMs: Number.isFinite(traceStartMs) && Number.isFinite(traceEndMs) ? traceEndMs - traceStartMs : 0,
    traceStartTime: Number.isFinite(traceStartMs) ? new Date(traceStartMs).toISOString() : "",
    services: [...services],
  };
}

function formatDurationMs(ms: number): string {
  if (ms < 1) return `${Math.round(ms * 1000)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatDurationNs(ns: number): string {
  return formatDurationMs(ns / 1_000_000);
}

function statusColor(status: string) {
  if (status === "Error") return red(status);
  if (status === "Ok") return green(status);
  return dim(status || "Unset");
}

function renderSpanTree(output: { log: (message: string) => void }, spans: SpanNode[]) {
  function visit(span: SpanNode, isLastStack: boolean[]) {
    const prefix = isLastStack.slice(0, -1).map((last) => last ? "   " : "│  ").join("");
    const branch = isLastStack.length === 0 ? "" : isLastStack[isLastStack.length - 1] ? "└─ " : "├─ ";
    const name = span.statusCode === "Error" ? red(span.spanName) : span.spanName;
    const service = cyan(span.serviceName || "(missing)");
    output.log(`${dim(prefix + branch)}${name} ${dim(`[${service}]`)} ${dim(formatDurationMs(span.durationMs))} ${statusColor(span.statusCode)}`);
    span.children.forEach((child, index) => visit(child, [...isLastStack, index === span.children.length - 1]));
  }

  spans.forEach((span, index) => visit(span, spans.length === 1 ? [] : [index === spans.length - 1]));
}

function buildTimeConditions(options: { since?: string; until?: string }) {
  const conditions = [`Timestamp >= ${parseTimeBoundary(options.since || "1h")}`];
  if (options.until) conditions.push(`Timestamp <= ${parseTimeBoundary(options.until)}`);
  return conditions;
}

tracesCli
  .command(
    "traces list",
    dedent`
      List distributed traces in a project, grouped by TraceId.

      Use this to find trace IDs before running \`strada traces view\`.
      The command scans otel_traces in the selected time range, summarizes span
      counts, services, error spans, duration, and the first root span when one
      exists. Project isolation is enforced by the project-scoped query API.
    `,
  )
  .option("-p, --project <slug>", z.array(z.string()).describe("Project slug (repeatable)"))
  .option("-s, --service [name]", "Filter by ServiceName")
  .option("--since [time]", "Start time: duration (1h, 7d) or ISO date (default: 1h)")
  .option("--until [time]", "End time: duration (1h) or ISO date")
  .option("--errors", "Only show traces with error spans")
  .option("-n, --limit [count]", "Max traces (default: 50)")
  .option("--json", "Print raw JSON response")
  .action(async (options, { console: output, process: proc }) => {
    if (!options.project || options.project.length === 0) {
      output.log("Missing required option: --project <slug>");
      output.log(dim("Run `strada projects list` to see available project slugs."));
      return proc.exit(1);
    }

    const org = await ensureDefaultOrg();
    const projects = await Promise.all(options.project.map((slug) => resolveProjectId(org.id, slug)));
    const limit = Number(options.limit) || 50;
    const conditions = buildTimeConditions(options);
    if (options.service) conditions.push(`ServiceName = '${options.service}'`);
    const having = options.errors ? "\nHAVING ErrorSpanCount > 0" : "";

    const sql = `
SELECT
    TraceId,
    min(Timestamp) AS StartTime,
    max(toUnixTimestamp64Nano(Timestamp) + Duration) - min(toUnixTimestamp64Nano(Timestamp)) AS DurationNs,
    count() AS SpanCount,
    groupUniqArray(ServiceName) AS Services,
    countIf(StatusCode = 'Error') AS ErrorSpanCount,
    anyIf(SpanName, ParentSpanId = '') AS RootSpanName,
    anyIf(ServiceName, ParentSpanId = '') AS RootServiceName,
    anyIf(StatusCode, ParentSpanId = '') AS RootStatusCode
FROM otel_traces
WHERE ${conditions.join("\n  AND ")}
GROUP BY TraceId
${having}
ORDER BY StartTime DESC
LIMIT ${limit}
`.trim();

    const results = await Promise.all(projects.map((project) => queryProject(project.id, sql)));
    const rows = results.flatMap((result) => result.data ?? []) as QueryRow[];

    if (options.json) {
      output.log(JSON.stringify({ data: rows, rows: rows.length }, null, 2));
      return;
    }

    if (rows.length === 0) {
      output.log(dim(`No traces found in ${cyan(options.project.join(", "))} (last ${options.since || "1h"})`));
      return;
    }

    output.log("");
    output.log(bold(`Traces in ${cyan(options.project.join(", "))}`) + dim(` (last ${options.since || "1h"})`));
    if (options.service) output.log(dim(`  service: ${options.service}`));
    if (options.errors) output.log(dim("  errors only"));
    output.log("");

    printTable(output, {
      columns: [
        { key: "trace", label: "TRACE", color: cyan, maxWidth: 16 },
        { key: "root", label: "ROOT SPAN", maxWidth: 36 },
        { key: "service", label: "SERVICE", color: cyan, maxWidth: 24 },
        { key: "spans", label: "SPANS", align: "right", color: bold },
        { key: "errors", label: "ERR", align: "right", color: red },
        { key: "duration", label: "DURATION", align: "right", color: yellow },
        { key: "start", label: "START", color: dim },
      ],
      rows: rows.map((row) => ({
        trace: str(row, "TraceId"),
        root: str(row, "RootSpanName") || gray("(no root)"),
        service: str(row, "RootServiceName") || String(row.Services ?? ""),
        spans: formatCount(num(row, "SpanCount")),
        errors: formatCount(num(row, "ErrorSpanCount")),
        duration: formatDurationNs(num(row, "DurationNs")),
        start: timeAgo(str(row, "StartTime")),
      })),
    });

    output.log("");
  });

tracesCli
  .command(
    "traces view <traceId>",
    dedent`
      Render one distributed trace as a parent-child span tree.

      Use a TraceId from \`strada traces list\` or from logs/errors. The SQL
      fetches all spans for that TraceId, then the CLI builds a SpanNode tree
      from SpanId and ParentSpanId. Use \`--json\` to print a shape designed to
      match the trace-view timeline UI, making future code sharing simple.
    `,
  )
  .option("-p, --project <slug>", "Project slug")
  .option("--json", "Print trace-view compatible JSON")
  .action(async (traceId, options, { console: output, process: proc }) => {
    if (!options.project) {
      output.log("Missing required option: --project <slug>");
      output.log(dim("Run `strada projects list` to see available project slugs."));
      return proc.exit(1);
    }

    const org = await ensureDefaultOrg();
    const project = await resolveProjectId(org.id, options.project);
    const sql = `
SELECT
    TraceId,
    SpanId,
    ParentSpanId,
    SpanName,
    ServiceName,
    SpanKind,
    Duration,
    Timestamp,
    StatusCode,
    StatusMessage,
    SpanAttributes,
    ResourceAttributes
FROM otel_traces
WHERE TraceId = '${traceId}'
ORDER BY Timestamp ASC
LIMIT 10000
`.trim();

    const result = await queryProject(project.id, sql);
    const rows = ((result.data ?? []) as QueryRow[]).map((row) => toTraceRow(row));
    const trace = buildSpanTree(rows);

    if (options.json) {
      output.log(JSON.stringify(trace, null, 2));
      return;
    }

    if (rows.length === 0) {
      output.log(dim(`No spans found for trace ${cyan(traceId)} in ${cyan(options.project)}`));
      return proc.exit(1);
    }

    output.log("");
    output.log(bold(`Trace ${cyan(traceId)}`));
    output.log(dim(`  ${formatCount(rows.length)} spans · ${formatDurationMs(trace.totalDurationMs)} · ${trace.services.join(", ")}`));
    output.log("");
    renderSpanTree(output, trace.rootSpans);
    output.log("");
  });
