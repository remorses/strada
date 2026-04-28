// Services CLI commands. Discovers service.name values from OTel logs and
// traces in a project, then summarizes recent volume so users know which
// ServiceName filters are available for logs, issues, and query workflows.

import { goke } from "goke";
import dedent from "string-dedent";
import { z } from "zod";
import { bold, cyan, dim, red, yellow, gray } from "./colors.ts";
import { ensureDefaultOrg, resolveProjectId } from "./projects.ts";
import { queryProject } from "./issues.ts";
import { printTable, formatCount, timeAgo } from "./table.ts";
import { parseTimeBoundary } from "./parse-duration.ts";

export const servicesCli = goke();

interface ServiceSummary {
  serviceName: string;
  logs: number;
  logErrors: number;
  spans: number;
  spanErrors: number;
  lastSeen: string;
}

type QueryRow = Record<string, string | number | null | undefined>;

function str(row: QueryRow, key: string): string {
  const value = row[key];
  if (value == null) return "";
  return String(value);
}

function num(row: QueryRow, key: string): number {
  return Number(row[key] ?? 0) || 0;
}

function mergeService(map: Map<string, ServiceSummary>, patch: Partial<ServiceSummary> & { serviceName: string }) {
  const key = patch.serviceName;
  const current = map.get(key) ?? {
    serviceName: key,
    logs: 0,
    logErrors: 0,
    spans: 0,
    spanErrors: 0,
    lastSeen: "",
  };

  current.logs += patch.logs ?? 0;
  current.logErrors += patch.logErrors ?? 0;
  current.spans += patch.spans ?? 0;
  current.spanErrors += patch.spanErrors ?? 0;
  if (!current.lastSeen || (patch.lastSeen && patch.lastSeen > current.lastSeen)) {
    current.lastSeen = patch.lastSeen ?? current.lastSeen;
  }
  map.set(key, current);
}

servicesCli
  .command(
    "services list",
    dedent`
      Find service names that are actively generating logs or traces.

      Use this before filtering logs, issues, or SQL queries by ServiceName.
      It helps discover the real service.name values present in a project and
      shows which services are currently producing telemetry in the selected
      time range.
    `,
  )
  .option("-p, --project <slug>", z.array(z.string()).describe("Project slug (repeatable)"))
  .option("--since [time]", "Start time: duration (1h, 7d) or ISO date (default: 24h)")
  .option("--until [time]", "End time: duration (1h) or ISO date")
  .option("-n, --limit [count]", "Max services (default: 100)")
  .option("--json", "Print raw JSON response")
  .action(async (options, { console: output, process: proc }) => {
    if (!options.project || options.project.length === 0) {
      output.log("Missing required option: --project <slug>");
      output.log(dim("Run `strada projects list` to see available project slugs."));
      return proc.exit(1);
    }

    const org = await ensureDefaultOrg();
    const slugs = options.project;
    const projects = await Promise.all(slugs.map((slug) => resolveProjectId(org.id, slug)));
    const limit = Number(options.limit) || 100;

    const conditions = [`Timestamp >= ${parseTimeBoundary(options.since || "24h")}`];
    if (options.until) conditions.push(`Timestamp <= ${parseTimeBoundary(options.until)}`);
    const where = conditions.join("\n  AND ");

    const logsSql = `
SELECT
    ServiceName,
    count() AS logs,
    countIf(SeverityText IN ('ERROR', 'FATAL')) AS log_errors,
    max(Timestamp) AS last_seen
FROM otel_logs
WHERE ${where}
GROUP BY ServiceName
ORDER BY logs DESC
LIMIT ${limit}
`.trim();

    const tracesSql = `
SELECT
    ServiceName,
    count() AS spans,
    countIf(StatusCode = 'Error') AS span_errors,
    max(Timestamp) AS last_seen
FROM otel_traces
WHERE ${where}
GROUP BY ServiceName
ORDER BY spans DESC
LIMIT ${limit}
`.trim();

    const [logsResults, tracesResults] = await Promise.all([
      Promise.all(projects.map((project) => queryProject(project.id, logsSql))),
      Promise.all(projects.map((project) => queryProject(project.id, tracesSql))),
    ]);

    const services = new Map<string, ServiceSummary>();
    for (const row of logsResults.flatMap((result) => result.data ?? [])) {
      mergeService(services, {
        serviceName: str(row, "ServiceName"),
        logs: num(row, "logs"),
        logErrors: num(row, "log_errors"),
        lastSeen: str(row, "last_seen"),
      });
    }
    for (const row of tracesResults.flatMap((result) => result.data ?? [])) {
      mergeService(services, {
        serviceName: str(row, "ServiceName"),
        spans: num(row, "spans"),
        spanErrors: num(row, "span_errors"),
        lastSeen: str(row, "last_seen"),
      });
    }

    const rows = [...services.values()]
      .sort((a, b) => b.logs + b.spans - (a.logs + a.spans))
      .slice(0, limit);

    if (options.json) {
      output.log(JSON.stringify({ data: rows, rows: rows.length }, null, 2));
      return;
    }

    if (rows.length === 0) {
      output.log(dim(`No services found in ${cyan(slugs.join(", "))} (last ${options.since || "24h"})`));
      return;
    }

    output.log("");
    output.log(bold(`Services in ${cyan(slugs.join(", "))}`) + dim(` (last ${options.since || "24h"})`));
    output.log("");

    printTable(output, {
      columns: [
        { key: "service", label: "SERVICE", color: cyan, maxWidth: 36 },
        { key: "logs", label: "LOGS", align: "right", color: bold },
        { key: "logErrors", label: "LOG ERR", align: "right", color: red },
        { key: "spans", label: "SPANS", align: "right", color: bold },
        { key: "spanErrors", label: "SPAN ERR", align: "right", color: yellow },
        { key: "lastSeen", label: "LAST SEEN", color: dim },
      ],
      rows: rows.map((row) => ({
        service: row.serviceName || gray("(missing)"),
        logs: formatCount(row.logs),
        logErrors: formatCount(row.logErrors),
        spans: formatCount(row.spans),
        spanErrors: formatCount(row.spanErrors),
        lastSeen: row.lastSeen ? timeAgo(row.lastSeen) : dim("—"),
      })),
    });

    output.log("");
  });
