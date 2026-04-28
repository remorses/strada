// Logs CLI commands. Browse, search, and summarize OTel log records from
// otel_logs. Renders compact colored lines by default (one log per line),
// or raw JSON with --json. Supports filtering by service, severity level,
// full-text search on Body, and trace correlation.
//
// Both --since and --until accept relative durations ("1h", "7d") or ISO
// dates ("2026-04-28", "2026-04-28T10:30:00Z").

import { goke } from "goke";
import { z } from "zod";
import { bold, cyan, dim, red, yellow, gray, green, white } from "./colors.ts";
import { ensureDefaultOrg, resolveProjectId } from "./projects.ts";
import { queryProject } from "./issues.ts";
import { printTable, formatCount } from "./table.ts";
import { parseTimeBoundary, isIsoDate, parseDuration } from "./parse-duration.ts";

export const logsCli = goke();

// ── Severity helpers ──────────────────────────────────────────────

const SEVERITY_LEVELS: Record<string, number> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
};

const severityColor: Record<string, (s: string) => string> = {
  TRACE: gray,
  DEBUG: gray,
  INFO: cyan,
  WARN: yellow,
  ERROR: red,
  FATAL: red,
};

function colorSeverity(level: string): string {
  const color = severityColor[level.toUpperCase()] || dim;
  return color(level.toUpperCase().padEnd(5));
}

function formatTimestamp(ts: string): string {
  // ClickHouse returns "2026-04-28 10:50:29.481000000", trim nanoseconds
  const match = ts.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  if (match) return dim(`${match[1]} ${match[2]}`);
  // Try ISO format
  const iso = ts.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  if (iso) return dim(`${iso[1]} ${iso[2]}`);
  return dim(ts);
}

function formatAttributes(attrs: Record<string, string> | string): string {
  if (typeof attrs === "string") {
    try {
      attrs = JSON.parse(attrs);
    } catch {
      return "";
    }
  }
  if (!attrs || typeof attrs !== "object") return "";

  const parts: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    // Skip "message" since it's already in the body
    if (k === "message") continue;
    const val = String(v);
    // Truncate long values
    const display = val.length > 80 ? val.slice(0, 77) + "..." : val;
    parts.push(gray(`${k}=`) + dim(display));
  }
  return parts.length > 0 ? "  " + parts.join("  ") : "";
}

// ── Shared options ────────────────────────────────────────────────

function buildTimeConditions(options: { since?: string; until?: string }): string[] {
  const conditions: string[] = [];
  const since = options.since || "1h";
  conditions.push(`Timestamp >= ${parseTimeBoundary(since)}`);
  if (options.until) {
    conditions.push(`Timestamp <= ${parseTimeBoundary(options.until)}`);
  }
  return conditions;
}

// ── logs list ─────────────────────────────────────────────────────

logsCli
  .command("logs [subcommand]", "Browse and search log records")
  .option("-p, --project <slug>", z.array(z.string()).describe("Project slug (repeatable)"))
  .option("-s, --service [name]", "Filter by ServiceName")
  .option("--since [time]", "Start time: duration (1h, 7d) or ISO date (default: 1h)")
  .option("--until [time]", "End time: duration (1h) or ISO date")
  .option("--min-level [level]", "Minimum severity: trace, debug, info, warn, error, fatal")
  .option("--search [text]", "Full-text search on log body")
  .option("--trace-id [id]", "Show logs for a specific trace")
  .option("-n, --limit [count]", "Max rows (default: 200)")
  .option("--json", "Print raw JSON response")
  .action(async (subcommand, options, { console: output, process: proc }) => {
    if (subcommand && subcommand !== "list" && subcommand !== "stats") {
      output.log(`Unknown subcommand: ${subcommand}`);
      output.log(dim("Usage: strada logs [list|stats] [options]"));
      return proc.exit(1);
    }

    if (!options.project || options.project.length === 0) {
      output.log("Missing required option: --project <slug>");
      output.log(dim("Run `strada projects list` to see available project slugs."));
      return proc.exit(1);
    }

    const org = await ensureDefaultOrg();
    const slugs = options.project;
    const projects = await Promise.all(slugs.map((s) => resolveProjectId(org.id, s)));

    // ── stats subcommand ──────────────────────────────────────────
    if (subcommand === "stats") {
      const conditions = buildTimeConditions(options);
      if (options.service) conditions.push(`ServiceName = '${options.service}'`);

      const sql = `
SELECT
    ServiceName,
    count() AS total,
    countIf(SeverityText = 'DEBUG' OR SeverityText = 'TRACE') AS debug,
    countIf(SeverityText = 'INFO') AS info,
    countIf(SeverityText = 'WARN') AS warn,
    countIf(SeverityText = 'ERROR') AS error,
    countIf(SeverityText = 'FATAL') AS fatal
FROM otel_logs
WHERE ${conditions.join("\n  AND ")}
GROUP BY ServiceName
ORDER BY total DESC
LIMIT 50
`.trim();

      const results = await Promise.all(projects.map((p) => queryProject(p.id, sql)));
      const allRows = results.flatMap((data) => data.data ?? []);

      if (allRows.length === 0) {
        output.log(dim(`No logs found in ${cyan(slugs.join(", "))} (last ${options.since || "1h"})`));
        return;
      }

      const sinceLabel = options.since || "1h";
      output.log("");
      output.log(bold(`Log volume`) + dim(` (last ${sinceLabel})`));
      output.log("");

      printTable(output, {
        columns: [
          { key: "service", label: "SERVICE", color: cyan },
          { key: "total", label: "TOTAL", align: "right", color: bold },
          { key: "debug", label: "DEBUG", align: "right", color: gray },
          { key: "info", label: "INFO", align: "right", color: cyan },
          { key: "warn", label: "WARN", align: "right", color: yellow },
          { key: "error", label: "ERROR", align: "right", color: red },
          { key: "fatal", label: "FATAL", align: "right", color: red },
        ],
        rows: allRows.map((r) => ({
          service: String(r.ServiceName ?? ""),
          total: formatCount(Number(r.total ?? 0)),
          debug: formatCount(Number(r.debug ?? 0)),
          info: formatCount(Number(r.info ?? 0)),
          warn: formatCount(Number(r.warn ?? 0)),
          error: formatCount(Number(r.error ?? 0)),
          fatal: formatCount(Number(r.fatal ?? 0)),
        })),
      });

      output.log("");
      return;
    }

    // ── list (default) ────────────────────────────────────────────
    const limit = Number(options.limit) || 200;

    // Build WHERE clauses
    const conditions = buildTimeConditions(options);
    if (options.service) conditions.push(`ServiceName = '${options.service}'`);
    if (options.traceId) conditions.push(`TraceId = '${options.traceId}'`);
    if (options.search) conditions.push(`Body LIKE '%${options.search}%'`);
    if (options.minLevel) {
      const minNum = SEVERITY_LEVELS[options.minLevel.toLowerCase()];
      if (minNum === undefined) {
        output.log(`Invalid --min-level: ${options.minLevel}`);
        output.log(dim("Valid levels: trace, debug, info, warn, error, fatal"));
        return proc.exit(1);
      }
      conditions.push(`SeverityNumber >= ${minNum}`);
    }

    const sql = `
SELECT
    Timestamp,
    SeverityText,
    ServiceName,
    Body,
    LogAttributes,
    TraceId,
    SpanId
FROM otel_logs
WHERE ${conditions.join("\n  AND ")}
ORDER BY Timestamp DESC
LIMIT ${limit}
`.trim();

    const results = await Promise.all(projects.map((p) => queryProject(p.id, sql)));
    const allRows = results.flatMap((data) => data.data ?? []);

    if (options.json) {
      output.log(JSON.stringify({ data: allRows, rows: allRows.length }, null, 2));
      return;
    }

    if (allRows.length === 0) {
      output.log(dim(`No logs found in ${cyan(slugs.join(", "))} (last ${options.since || "1h"})`));
      return;
    }

    // Header
    const sinceLabel = options.since || "1h";
    output.log("");
    output.log(bold(`Logs in ${cyan(slugs.join(", "))}`) + dim(` (last ${sinceLabel})`));
    if (options.service) output.log(dim(`  service: ${options.service}`));
    if (options.minLevel) output.log(dim(`  min level: ${options.minLevel}`));
    if (options.search) output.log(dim(`  search: "${options.search}"`));
    if (options.traceId) output.log(dim(`  trace: ${options.traceId}`));
    output.log("");

    // Render compact log lines (newest first, matching ORDER BY DESC)
    for (const row of allRows) {
      const ts = formatTimestamp(String(row.Timestamp ?? ""));
      const severity = colorSeverity(String(row.SeverityText ?? "INFO"));
      const service = dim(`[${String(row.ServiceName ?? "")}]`);
      const body = String(row.Body ?? "");
      const attrs = formatAttributes(row.LogAttributes as Record<string, string>);

      output.log(`${ts}  ${severity} ${service}  ${body}${attrs}`);
    }

    output.log("");
    output.log(dim(`  ${bold(String(allRows.length))} log${allRows.length === 1 ? "" : "s"}`));
    output.log("");
  });


