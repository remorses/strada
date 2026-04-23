// Error listing and detail CLI commands. Groups errors by fingerprint and
// displays a frequency-sorted table, or shows a detailed view of a single
// error group with stacktrace and recent events.

import { goke } from "goke";
import { z } from "zod";
import { bold, cyan, dim, red, yellow, gray, green, white } from "./colors.ts";
import { getApiClient } from "./api-client.ts";
import { ensureDefaultOrg, resolveProjectId } from "./projects.ts";
import { printTable, formatCount, timeAgo } from "./table.ts";
import { parseDuration } from "./parse-duration.ts";

export const errorsCli = goke();

/** Run a SQL query against a project. Shared by errors subcommands and the query command. */
export async function queryProject(projectId: string, sql: string) {
  const { safeFetch } = getApiClient();
  const res = await safeFetch("/api/v0/projects/:projectId/query", {
    method: "POST",
    params: { projectId },
    body: { sql },
  });
  if (res instanceof Error) throw res;
  return res;
}

/** Safely read a field as string from a query result row */
function str(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (v == null) return "";
  if (typeof v === "string") return v;
  return String(v);
}

// ── errors list ───────────────────────────────────────────────────

errorsCli
  .command("errors list", "List error groups sorted by frequency")
  .option("-p, --project <slug>", z.array(z.string()).describe("Project slug (repeatable)"))
  .option("-s, --service [name]", "Filter by service name")
  .option("--since [duration]", "Time range, e.g. 1h, 24h, 7d (default: 24h)")
  .option("-n, --limit [count]", "Max number of error groups (default: 20)")
  .option("--unhandled", "Show only unhandled errors")
  .action(async (options, { console: output, process: proc }) => {
    if (!options.project || options.project.length === 0) {
      output.log("Missing required option: --project <slug>");
      output.log(dim("Run `strada projects list` to see available project slugs."));
      return proc.exit(1);
    }

    const org = await ensureDefaultOrg();
    const slugs = options.project;
    const projects = await Promise.all(slugs.map((s) => resolveProjectId(org.id, s)));

    const since = parseDuration(options.since || "24h");
    const limit = Number(options.limit) || 20;

    // Build WHERE clauses
    const conditions = [`Timestamp >= now() - INTERVAL ${since}`];
    if (options.service) {
      conditions.push(`ServiceName = '${options.service}'`);
    }
    if (options.unhandled) {
      conditions.push(`MechanismHandled = false`);
    }

    const sql = `
SELECT
    FingerprintHash,
    anyLast(ExceptionType) AS last_type,
    anyLast(ExceptionMessage) AS last_message,
    anyLast(Level) AS last_level,
    count() AS event_count,
    min(Timestamp) AS first_seen,
    max(Timestamp) AS last_seen,
    countIf(MechanismHandled = false) AS unhandled_count
FROM otel_errors
WHERE ${conditions.join("\n  AND ")}
GROUP BY FingerprintHash
ORDER BY event_count DESC
LIMIT ${limit}
`.trim();

    // Query all projects in parallel and merge results
    const results = await Promise.all(projects.map((p) => queryProject(p.id, sql)));
    const allRows = results.flatMap((data) => data.data ?? []);

    if (allRows.length === 0) {
      const slugLabel = slugs.join(", ");
      output.log(dim(`No errors found in ${cyan(slugLabel)} (last ${options.since || "24h"})`));
      return;
    }

    // Header
    const sinceLabel = options.since || "24h";
    const slugLabel = slugs.join(", ");
    output.log("");
    output.log(bold(`Errors in ${cyan(slugLabel)}`) + dim(` (last ${sinceLabel})`));
    if (options.service) output.log(dim(`  service: ${options.service}`));
    output.log("");

    // Format rows for table
    const tableRows = allRows.map((r) => {
      const count = Number(r.event_count ?? 0);
      const unhandled = Number(r.unhandled_count ?? 0);
      const level = str(r, "last_level") || "error";
      const levelColor = level === "fatal" ? red : level === "warning" ? yellow : red;

      return {
        count: formatCount(count),
        unhandled: unhandled > 0 ? formatCount(unhandled) : dim("0"),
        level: levelColor(level),
        type: str(r, "last_type") || gray("(none)"),
        message: str(r, "last_message") || gray("(no message)"),
        last_seen: timeAgo(str(r, "last_seen")),
      };
    });

    printTable(output, {
      columns: [
        { key: "count", label: "COUNT", align: "right", color: bold },
        { key: "unhandled", label: "UNHANDLED", align: "right" },
        { key: "level", label: "LEVEL" },
        { key: "type", label: "TYPE", color: cyan },
        { key: "message", label: "MESSAGE", maxWidth: 50 },
        { key: "last_seen", label: "LAST SEEN", color: dim },
      ],
      rows: tableRows,
    });

    // Summary line
    const totalEvents = allRows.reduce((sum, r) => sum + Number(r.event_count ?? 0), 0);
    output.log("");
    output.log(dim(`  ${allRows.length} issues, ${formatCount(totalEvents)} total events`));
    output.log("");
  });

// ── errors view ───────────────────────────────────────────────────

errorsCli
  .command("errors view <fingerprint>", "Show details for a single error group by fingerprint hash")
  .option("-p, --project <slug>", "Project slug (run `strada projects list` to see slugs)")
  .option("-n, --events [count]", "Number of recent events to show (default: 5)")
  .option("--json", "Output raw JSON")
  .action(async (fingerprint, options, { console: output, process: proc }) => {
    if (!options.project) {
      output.log("Missing required option: --project <slug>");
      output.log(dim("Run `strada projects list` to see available project slugs."));
      return proc.exit(1);
    }

    const org = await ensureDefaultOrg();
    const project = await resolveProjectId(org.id, options.project);
    const eventsLimit = Number(options.events) || 5;

    // Query 1: Issue summary (aggregated)
    const summarySql = `
SELECT
    anyLast(ExceptionType) AS last_type,
    anyLast(ExceptionMessage) AS last_message,
    anyLast(Level) AS last_level,
    anyLast(MechanismType) AS last_mechanism,
    anyLast(MechanismHandled) AS last_handled,
    count() AS event_count,
    countIf(MechanismHandled = false) AS unhandled_count,
    min(Timestamp) AS first_seen,
    max(Timestamp) AS last_seen,
    groupUniqArray(ServiceName) AS services,
    groupUniqArray(Release) AS releases,
    groupUniqArray(Environment) AS environments
FROM otel_errors
WHERE FingerprintHash = '${fingerprint}'
LIMIT 1
`.trim();

    // Query 2: Recent events with stacktrace
    const eventsSql = `
SELECT
    Timestamp,
    ExceptionType,
    ExceptionMessage,
    ExceptionStacktrace,
    ExceptionFrames,
    MechanismType,
    MechanismHandled,
    Level,
    Release,
    Environment,
    ServiceName,
    TraceId,
    SpanId,
    Tags
FROM otel_errors
WHERE FingerprintHash = '${fingerprint}'
ORDER BY Timestamp DESC
LIMIT ${eventsLimit}
`.trim();

    const [summaryRes, eventsRes] = await Promise.all([
      queryProject(project.id, summarySql),
      queryProject(project.id, eventsSql),
    ]);

    const summary = summaryRes.data?.[0];
    const events = eventsRes.data ?? [];

    if (!summary || Number(summary.event_count) === 0) {
      output.log(dim(`No error found with fingerprint ${cyan(fingerprint)}`));
      return proc.exit(1);
    }

    if (options.json) {
      output.log(JSON.stringify({ summary, events }, null, 2));
      return;
    }

    // ── Render summary ──
    const type = str(summary, "last_type") || "(unknown)";
    const message = str(summary, "last_message") || "(no message)";
    const level = str(summary, "last_level") || "error";
    const levelColor = level === "fatal" ? red : level === "warning" ? yellow : red;
    const handledVal = str(summary, "last_handled");
    const handled = handledVal === "true" || handledVal === "1";
    const mechanism = str(summary, "last_mechanism") || "generic";
    const firstSeen = str(summary, "first_seen");
    const lastSeen = str(summary, "last_seen");

    output.log("");
    output.log(bold(red(`${type}: ${message}`)));
    output.log("");
    output.log(`  ${dim("Fingerprint")}   ${cyan(fingerprint)}`);
    output.log(`  ${dim("Level")}         ${levelColor(level)}`);
    output.log(`  ${dim("Events")}        ${bold(formatCount(Number(summary.event_count)))} total${Number(summary.unhandled_count) > 0 ? ` (${red(formatCount(Number(summary.unhandled_count)))} unhandled)` : ""}`);
    output.log(`  ${dim("First seen")}    ${firstSeen} ${dim(`(${timeAgo(firstSeen)})`)}`);
    output.log(`  ${dim("Last seen")}     ${lastSeen} ${dim(`(${timeAgo(lastSeen)})`)}`);
    output.log(`  ${dim("Mechanism")}     ${mechanism} ${handled ? green("(handled)") : red("(unhandled)")}`);

    // Services, releases, environments
    const services = parseClickHouseArray(summary.services);
    const releases = parseClickHouseArray(summary.releases).filter(Boolean);
    const environments = parseClickHouseArray(summary.environments).filter(Boolean);

    if (services.length > 0) {
      output.log(`  ${dim("Services")}      ${services.join(", ")}`);
    }
    if (releases.length > 0) {
      output.log(`  ${dim("Releases")}      ${releases.join(", ")}`);
    }
    if (environments.length > 0) {
      output.log(`  ${dim("Environments")}  ${environments.join(", ")}`);
    }

    // ── Render stacktrace from latest event ──
    const latestEvent = events[0];
    if (latestEvent) {
      output.log("");
      output.log(bold("  Stacktrace") + dim(" (latest event):"));
      output.log("");

      const rendered = renderStacktrace(str(latestEvent, "ExceptionFrames"), str(latestEvent, "ExceptionStacktrace"));
      for (const line of rendered) {
        output.log(line);
      }
    }

    // ── Render recent events table ──
    if (events.length > 0) {
      output.log("");
      output.log(bold("  Recent events:"));
      output.log("");

      const eventRows = events.map((e) => {
        const ts = str(e, "Timestamp").replace("T", " ").replace(/\.\d+Z?$/, "");
        const traceId = str(e, "TraceId");
        return {
          timestamp: ts,
          service: str(e, "ServiceName"),
          release: str(e, "Release") || dim("—"),
          env: str(e, "Environment") || dim("—"),
          trace: traceId ? traceId.slice(0, 12) + "…" : dim("—"),
        };
      });

      printTable(output, {
        columns: [
          { key: "timestamp", label: "TIMESTAMP" },
          { key: "service", label: "SERVICE", color: cyan },
          { key: "release", label: "RELEASE" },
          { key: "env", label: "ENV" },
          { key: "trace", label: "TRACE ID", color: dim },
        ],
        rows: eventRows,
      });
    }

    output.log("");
  });

// ── Stacktrace rendering ──────────────────────────────────────────

interface StackFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  abs_path?: string;
  in_app?: boolean;
}

function renderStacktrace(framesJson?: string, rawStacktrace?: string): string[] {
  // Try structured frames first
  if (framesJson) {
    try {
      const frames: StackFrame[] = JSON.parse(framesJson);
      if (frames.length > 0) {
        return renderStructuredFrames(frames);
      }
    } catch {
      // Invalid JSON, fall through to raw
    }
  }

  // Fall back to raw stacktrace string
  if (rawStacktrace) {
    return rawStacktrace.split("\n").map((line) => `    ${dim(line)}`);
  }

  return [dim("    (no stacktrace available)")];
}

function renderStructuredFrames(frames: StackFrame[]): string[] {
  const lines: string[] = [];
  // Frames are typically bottom-to-top; reverse for most-recent-first display
  const ordered = [...frames].reverse();

  for (const frame of ordered) {
    const fn = frame.function || "<anonymous>";
    const file = frame.filename || frame.abs_path || "<unknown>";
    const loc = frame.lineno != null
      ? frame.colno != null ? `${file}:${frame.lineno}:${frame.colno}` : `${file}:${frame.lineno}`
      : file;

    if (frame.in_app) {
      lines.push(`    ${white("at")} ${bold(fn)} ${cyan(`(${loc})`)}  ${dim("← in-app")}`);
    } else {
      lines.push(`    ${dim(`at ${fn} (${loc})`)}`);
    }
  }

  return lines;
}

/** Parse a value that may be a JS array, JSON array string, or ClickHouse array string */
function parseClickHouseArray(value?: unknown): string[] {
  if (!value) return [];
  // Already a JS array (Tinybird JSON response)
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  // JSON array string
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // ClickHouse format: ['val1','val2']
    const match = value.match(/^\[(.+)\]$/);
    if (match) {
      return match[1]!.split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    }
  }
  return [];
}
