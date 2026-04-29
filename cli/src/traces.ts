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
  ScopeName: string;
  ScopeVersion: string;
  ScopeAttributes: Record<string, string>;
  EventsTimestamp: string[];
  EventsName: string[];
  EventsAttributes: Record<string, string>[];
  LinksTraceId: string[];
  LinksSpanId: string[];
  LinksTraceState: string[];
  LinksAttributes: Record<string, string>[];
}

interface SpanEvent {
  timestamp: string;
  name: string;
  attributes: Record<string, string>;
}

interface SpanLink {
  traceId: string;
  spanId: string;
  traceState: string;
  attributes: Record<string, string>;
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
  scopeName: string;
  scopeVersion: string;
  scopeAttributes: Record<string, string>;
  events: SpanEvent[];
  links: SpanLink[];
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

function parseStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (error) {
    console.error(`Failed to parse trace array: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function parseAttributeArray(value: unknown): Record<string, string>[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((entry) => parseAttributes(entry));
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((entry) => parseAttributes(entry)) : [];
  } catch (error) {
    console.error(`Failed to parse trace attribute array: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function buildEvents(row: OtelTraceRow): SpanEvent[] {
  const length = Math.max(row.EventsName.length, row.EventsTimestamp.length, row.EventsAttributes.length);
  const events: SpanEvent[] = [];
  for (let i = 0; i < length; i++) {
    events.push({
      timestamp: row.EventsTimestamp[i] ?? "",
      name: row.EventsName[i] ?? "",
      attributes: row.EventsAttributes[i] ?? {},
    });
  }
  return events;
}

function buildLinks(row: OtelTraceRow): SpanLink[] {
  const length = Math.max(row.LinksTraceId.length, row.LinksSpanId.length, row.LinksAttributes.length);
  const links: SpanLink[] = [];
  for (let i = 0; i < length; i++) {
    links.push({
      traceId: row.LinksTraceId[i] ?? "",
      spanId: row.LinksSpanId[i] ?? "",
      traceState: row.LinksTraceState[i] ?? "",
      attributes: row.LinksAttributes[i] ?? {},
    });
  }
  return links;
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
    ScopeName: str(row, "ScopeName"),
    ScopeVersion: str(row, "ScopeVersion"),
    ScopeAttributes: parseAttributes(row.ScopeAttributes),
    EventsTimestamp: parseStringArray(row.EventsTimestamp),
    EventsName: parseStringArray(row.EventsName),
    EventsAttributes: parseAttributeArray(row.EventsAttributes),
    LinksTraceId: parseStringArray(row.LinksTraceId),
    LinksSpanId: parseStringArray(row.LinksSpanId),
    LinksTraceState: parseStringArray(row.LinksTraceState),
    LinksAttributes: parseAttributeArray(row.LinksAttributes),
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
      scopeName: row.ScopeName,
      scopeVersion: row.ScopeVersion,
      scopeAttributes: row.ScopeAttributes,
      events: buildEvents(row),
      links: buildLinks(row),
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

const PREVIEW_ATTRIBUTE_KEYS = [
  "http.method",
  "http.request.method",
  "http.route",
  "http.target",
  "url.path",
  "http.status_code",
  "http.response.status_code",
  "db.system",
  "db.operation",
  "db.statement",
  "rpc.service",
  "rpc.method",
  "messaging.operation.name",
  "messaging.destination.name",
  "user.id",
  "session.id",
];

const NOISY_ATTRIBUTE_PREFIXES = ["telemetry.", "process.", "host.", "os."];
const NOISY_ATTRIBUTE_KEYS = new Set([
  "exception.stacktrace",
  "exception.structured_frames",
  "exception.fingerprint",
  "exception.debug_id",
]);

function shortSpanId(spanId: string): string {
  return spanId.slice(0, 8) || "missing";
}

function truncatePreview(value: string, max = 40): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function isNoisyAttribute(key: string): boolean {
  return NOISY_ATTRIBUTE_KEYS.has(key) || NOISY_ATTRIBUTE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function previewAttributeEntries(attrs: Record<string, string>, count: number): Array<[string, string]> {
  if (count <= 0) return [];

  const entries = Object.entries(attrs).filter(([key, value]) => value !== "" && !isNoisyAttribute(key));
  const byKey = new Map(entries);
  const picked: Array<[string, string]> = [];
  const seen = new Set<string>();

  for (const key of PREVIEW_ATTRIBUTE_KEYS) {
    const value = byKey.get(key);
    if (value === undefined) continue;
    picked.push([key, value]);
    seen.add(key);
    if (picked.length >= count) return picked;
  }

  for (const [key, value] of entries) {
    if (seen.has(key)) continue;
    picked.push([key, value]);
    if (picked.length >= count) return picked;
  }

  return picked;
}

function formatAttributePreview(attrs: Record<string, string>, count: number): string {
  const visibleAttrs = Object.entries(attrs).filter(([key, value]) => value !== "" && !isNoisyAttribute(key));
  const picked = previewAttributeEntries(attrs, count);
  if (picked.length === 0) return "";

  const preview = picked
    .map(([key, value]) => `${truncatePreview(key, 24)}=${truncatePreview(String(value), 40)}`)
    .join(" ");
  const hidden = visibleAttrs.length - picked.length;
  return hidden > 0 ? `${preview} ${dim(`+${hidden} attrs`)}` : preview;
}

function formatEventPreview(events: SpanEvent[]): string {
  const event = events.find((item) => item.name === "exception") ?? events[0];
  if (!event) return "";
  if (event.name !== "exception") return truncatePreview(event.name, 60);

  const type = event.attributes["exception.type"] ?? "";
  const message = event.attributes["exception.message"] ?? "";
  const details = [type, message].filter(Boolean).join(" ");
  return details ? `exception: ${truncatePreview(details, 60)}` : "exception";
}

function renderKeyValueSection(
  output: { log: (message: string) => void },
  title: string,
  attrs: Record<string, string>,
  prefix: string,
): void {
  const entries = Object.entries(attrs).filter(([, value]) => value !== "");
  if (entries.length === 0) return;

  output.log(`${dim(prefix)}${bold(title)}`);
  for (const [key, value] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const text = String(value);
    if (text.includes("\n")) {
      output.log(`${dim(prefix)}  ${cyan(key)}:`);
      for (const line of text.split("\n")) output.log(`${dim(prefix)}    ${line}`);
    } else {
      output.log(`${dim(prefix)}  ${cyan(key)}: ${text}`);
    }
  }
}

function renderEvents(output: { log: (message: string) => void }, span: SpanNode, prefix: string): void {
  if (span.events.length === 0) return;

  output.log(`${dim(prefix)}${bold("Events")}`);
  const spanStart = new Date(span.startTime).getTime();
  for (const event of span.events) {
    const eventTime = new Date(event.timestamp).getTime();
    const offset = Number.isFinite(spanStart) && Number.isFinite(eventTime)
      ? ` +${formatDurationMs(eventTime - spanStart)}`
      : "";
    output.log(`${dim(prefix)}  ${yellow(event.name || "(unnamed)")}${dim(offset)}`);
    for (const [key, value] of Object.entries(event.attributes).sort(([a], [b]) => a.localeCompare(b))) {
      output.log(`${dim(prefix)}    ${cyan(key)}: ${String(value)}`);
    }
  }
}

function renderLinks(output: { log: (message: string) => void }, links: SpanLink[], prefix: string): void {
  if (links.length === 0) return;

  output.log(`${dim(prefix)}${bold("Links")}`);
  for (const link of links) {
    output.log(`${dim(prefix)}  trace=${link.traceId} span=${link.spanId}`);
    if (link.traceState) output.log(`${dim(prefix)}    trace_state: ${link.traceState}`);
    for (const [key, value] of Object.entries(link.attributes).sort(([a], [b]) => a.localeCompare(b))) {
      output.log(`${dim(prefix)}    ${cyan(key)}: ${String(value)}`);
    }
  }
}

function renderExpandedSpan(output: { log: (message: string) => void }, span: SpanNode, prefix: string): void {
  output.log(`${dim(prefix)}${bold(`Span ${shortSpanId(span.spanId)}`)} ${dim(span.spanId)}`);
  output.log(`${dim(prefix)}  trace: ${span.traceId}`);
  if (span.parentSpanId) output.log(`${dim(prefix)}  parent: ${span.parentSpanId}`);
  output.log(`${dim(prefix)}  service: ${span.serviceName || "(missing)"}`);
  output.log(`${dim(prefix)}  kind: ${span.spanKind || "Unset"}`);
  output.log(`${dim(prefix)}  status: ${span.statusCode || "Unset"}${span.statusMessage ? ` ${span.statusMessage}` : ""}`);
  output.log(`${dim(prefix)}  duration: ${formatDurationMs(span.durationMs)}`);
  output.log(`${dim(prefix)}  start: ${span.startTime}`);
  if (span.scopeName || span.scopeVersion) {
    output.log(`${dim(prefix)}  scope: ${[span.scopeName, span.scopeVersion].filter(Boolean).join("@")}`);
  }
  output.log("");
  renderKeyValueSection(output, "Attributes", span.spanAttributes, prefix);
  renderKeyValueSection(output, "Resource", span.resourceAttributes, prefix);
  renderKeyValueSection(output, "Scope", span.scopeAttributes, prefix);
  renderEvents(output, span, prefix);
  renderLinks(output, span.links, prefix);
}

function collectSpans(spans: SpanNode[]): SpanNode[] {
  const all: SpanNode[] = [];
  function visit(span: SpanNode) {
    all.push(span);
    for (const child of span.children) visit(child);
  }
  for (const span of spans) visit(span);
  return all;
}

function resolveExpandedSpans(spans: SpanNode[], requested: string[]): { spans: Set<string>; missing: string[]; ambiguous: string[] } {
  const all = collectSpans(spans);
  const expanded = new Set<string>();
  const missing: string[] = [];
  const ambiguous: string[] = [];

  for (const id of requested) {
    const matches = all.filter((span) => span.spanId === id || span.spanId.startsWith(id));
    if (matches.length === 1) expanded.add(matches[0]!.spanId);
    else if (matches.length === 0) missing.push(id);
    else ambiguous.push(id);
  }

  return { spans: expanded, missing, ambiguous };
}

function renderSpanTree(
  output: { log: (message: string) => void },
  spans: SpanNode[],
  options: { attrs: number; expandSpan: string[] },
) {
  const expanded = resolveExpandedSpans(spans, options.expandSpan);

  function visit(span: SpanNode, isLastStack: boolean[]) {
    const prefix = isLastStack.slice(0, -1).map((last) => last ? "   " : "│  ").join("");
    const branch = isLastStack.length === 0 ? "" : isLastStack[isLastStack.length - 1] ? "└─ " : "├─ ";
    const name = span.statusCode === "Error" ? red(span.spanName) : span.spanName;
    const errorBadge = span.statusCode === "Error" ? `${red("[ERROR]")} ` : "";
    const errorMessage = span.statusCode === "Error" && span.statusMessage ? ` ${red(span.statusMessage)}` : "";
    const service = cyan(span.serviceName || "(missing)");
    const spanId = dim(`span=${shortSpanId(span.spanId)}`);
    const childPrefix = prefix + (isLastStack.length === 0 ? "" : isLastStack[isLastStack.length - 1] ? "   " : "│  ");
    output.log(`${dim(prefix + branch)}${errorBadge}${name} ${dim(`[${service} ${spanId}]`)} ${dim(formatDurationMs(span.durationMs))} ${statusColor(span.statusCode)}${errorMessage}`);

    const attrPreview = formatAttributePreview(span.spanAttributes, options.attrs);
    if (attrPreview) output.log(`${dim(childPrefix)}   ${dim("attrs")} ${attrPreview}`);

    const eventPreview = formatEventPreview(span.events);
    if (eventPreview) output.log(`${dim(childPrefix)}   ${dim("event")} ${eventPreview}`);

    if (expanded.spans.has(span.spanId)) {
      output.log("");
      renderExpandedSpan(output, span, `${childPrefix}   `);
      output.log("");
    }

    span.children.forEach((child, index) => visit(child, [...isLastStack, index === span.children.length - 1]));
  }

  spans.forEach((span, index) => visit(span, spans.length === 1 ? [] : [index === spans.length - 1]));
  for (const id of expanded.missing) output.log(yellow(`Could not find expanded span: ${id}`));
  for (const id of expanded.ambiguous) output.log(yellow(`Expanded span prefix is ambiguous: ${id}`));
}

function buildTimeConditions(options: { since?: string; until?: string }) {
  const conditions = [`Timestamp >= ${parseTimeBoundary(options.since || "1h")}`];
  if (options.until) conditions.push(`Timestamp <= ${parseTimeBoundary(options.until)}`);
  return conditions;
}

const TRACE_SPAN_COLUMNS = [
  "TraceId",
  "SpanId",
  "ParentSpanId",
  "SpanName",
  "ServiceName",
  "SpanKind",
  "Duration",
  "Timestamp",
  "StatusCode",
  "StatusMessage",
  "SpanAttributes",
  "ResourceAttributes",
  "ScopeName",
  "ScopeVersion",
  "ScopeAttributes",
  "EventsTimestamp",
  "EventsName",
  "EventsAttributes",
  "LinksTraceId",
  "LinksSpanId",
  "LinksTraceState",
  "LinksAttributes",
].join(",\n          ");

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
    const having = options.errors ? "HAVING ErrorSpanCount > 0" : "";

    const sql = dedent`
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
    "traces span <traceId> <spanId>",
    dedent`
      Show the full details for one span inside a trace.

      Use the short span id printed by \`strada traces view\`, or paste a full
      SpanId. The command prints all span attributes, resource attributes,
      scope attributes, exception events, and links without truncation. Use this
      after the compact tree has identified the span that needs inspection.
    `,
  )
  .option("-p, --project <slug>", "Project slug")
  .option("--json", "Print raw span JSON")
  .action(async (traceId, spanId, options, { console: output, process: proc }) => {
    if (!options.project) {
      output.log("Missing required option: --project <slug>");
      output.log(dim("Run `strada projects list` to see available project slugs."));
      return proc.exit(1);
    }

    const org = await ensureDefaultOrg();
    const project = await resolveProjectId(org.id, options.project);
    const sql = dedent`
      SELECT
          ${TRACE_SPAN_COLUMNS}
      FROM otel_traces
      WHERE TraceId = '${traceId}'
        AND startsWith(SpanId, '${spanId}')
      ORDER BY Timestamp ASC
      LIMIT 2
    `.trim();

    const result = await queryProject(project.id, sql);
    const rows = ((result.data ?? []) as QueryRow[]).map((row) => toTraceRow(row));

    if (rows.length === 0) {
      output.log(dim(`No span ${cyan(spanId)} found in trace ${cyan(traceId)} for ${cyan(options.project)}`));
      return proc.exit(1);
    }
    if (rows.length > 1) {
      output.log(yellow(`Span id prefix is ambiguous: ${spanId}`));
      output.log(dim(`Pass a longer prefix. Matches: ${rows.map((row) => row.SpanId).join(", ")}`));
      return proc.exit(1);
    }

    const trace = buildSpanTree(rows);
    const span = trace.rootSpans[0];
    if (!span) {
      output.log(dim(`No span ${cyan(spanId)} found in trace ${cyan(traceId)} for ${cyan(options.project)}`));
      return proc.exit(1);
    }

    if (options.json) {
      output.log(JSON.stringify(span, null, 2));
      return;
    }

    output.log("");
    renderExpandedSpan(output, span, "");
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
  .option("--attrs <count>", z.number().default(3).describe("Number of compact span attributes to show"))
  .option("-e, --expand-span <spanId>", z.array(z.string()).describe("SpanId or unique SpanId prefix to expand (repeatable)"))
  .option("--json", "Print trace-view compatible JSON")
  .action(async (traceId, options, { console: output, process: proc }) => {
    if (!options.project) {
      output.log("Missing required option: --project <slug>");
      output.log(dim("Run `strada projects list` to see available project slugs."));
      return proc.exit(1);
    }

    const org = await ensureDefaultOrg();
    const project = await resolveProjectId(org.id, options.project);
    const sql = dedent`
      SELECT
          ${TRACE_SPAN_COLUMNS}
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
    renderSpanTree(output, trace.rootSpans, {
      attrs: Math.max(0, Math.min(Number(options.attrs) || 0, 10)),
      expandSpan: options.expandSpan ?? [],
    });
    output.log("");
  });
