// General-purpose SQL query command for the Strada CLI.
//
// OUTPUT FORMAT
// =============
// The output format is controlled entirely by a ClickHouse FORMAT clause at the
// end of the SQL. There is no --format flag.
//
// No FORMAT clause (default)
//   strada query "SELECT * FROM otel_errors LIMIT 10" -p myapp
//   → Terminal table. The CLI injects FORMAT JSON behind the scenes, parses the
//     structured response, and renders an auto-sized, auto-coloured table.
//   → Add --json to get the raw JSON envelope instead of the table:
//       { data: [...], meta: [...], rows: N, statistics: { elapsed, rows_read, bytes_read } }
//
// FORMAT clause present
//   strada query "SELECT * FROM otel_errors LIMIT 10 FORMAT CSVWithNames" -p myapp
//   → Raw passthrough. The SQL is sent to Tinybird/ClickHouse unchanged and the
//     response body is written directly to stdout. Pipe it anywhere.
//
// Supported FORMAT values (ClickHouse native):
//   JSON          – { data, meta, rows, statistics } JSON envelope (application/json)
//   JSONEachRow   – NDJSON, one JSON object per line (application/x-ndjson)
//   CSV           – Comma-separated values, no header row (text/csv; header=absent)
//   CSVWithNames  – Comma-separated values with a header row (text/csv; header=present)
//   TSV           – Tab-separated values, no header row (text/tab-separated-values)
//   TSVWithNames  – Tab-separated values with a header row (text/tab-separated-values)
//   PrettyCompact – Unicode box-drawing table for human reading (text/plain)
//   Parquet       – Binary columnar format (application/octet-stream)
//   Prometheus    – Prometheus text-based exposition format (text/plain)
//
// Examples:
//   strada query "SELECT * FROM otel_errors LIMIT 10" -p myapp
//   strada query "SELECT * FROM otel_errors LIMIT 10" -p myapp --json
//   strada query "SELECT * FROM otel_errors LIMIT 100 FORMAT CSVWithNames" -p myapp > errors.csv
//   strada query "SELECT ServiceName, count() AS n FROM otel_traces GROUP BY 1 FORMAT JSONEachRow" -p myapp | jq .
//   strada query "SELECT * FROM otel_logs LIMIT 5 FORMAT PrettyCompact" -p myapp

import { goke } from "goke";
import { bold, dim } from "./colors.ts";
import { ensureDefaultOrg, resolveProjectId } from "./projects.ts";
import { printTable } from "./table.ts";
import { queryProject } from "./issues.ts";

export const queryCli = goke();

queryCli
  .command("query <sql>", "Run a SQL query against a project. Append FORMAT <name> to the SQL to change output: JSON, JSONEachRow, CSV, CSVWithNames, TSV, TSVWithNames, PrettyCompact, Parquet, Prometheus. Without a FORMAT clause the CLI renders a table; add --json to get the raw JSON envelope { data, meta, rows, statistics } instead.")
  .option("-p, --project <slug>", "Project slug (run `strada projects list` to see slugs)")
  .option("--json", "Print the raw JSON envelope { data, meta, rows, statistics } instead of a table (only applies when no FORMAT clause is in the SQL)")
  .action(async (sql: string, options, { console: output, process: proc }) => {
    if (!options.project) {
      output.log("Missing required option: --project <slug>");
      output.log(dim("Run `strada projects list` to see available project slugs."));
      return proc.exit(1);
    }

    const org = await ensureDefaultOrg();
    const project = await resolveProjectId(org.id, options.project);

    const res = await queryProject(project.id, sql);

    // ── Raw passthrough: FORMAT was present in the SQL ────────────────────────
    // The website forwarded the response body as-is. Write it straight to stdout
    // so the caller can pipe it anywhere (> file.csv, | jq, etc.).
    if (res.raw !== undefined) {
      proc.stdout.write(res.raw);
      return;
    }

    // ── Structured JSON response: no FORMAT in SQL ────────────────────────────
    if (options.json) {
      output.log(JSON.stringify(res, null, 2));
      return;
    }

    const rows = res.data ?? [];
    const meta = res.meta ?? [];

    if (rows.length === 0) {
      output.log(dim("No rows returned."));
      return;
    }

    // Build columns from meta (preserves server-side column order).
    // Fall back to keys of the first row when meta is absent.
    const columnKeys: string[] = meta.length > 0
      ? meta.map((m) => m.name)
      : Object.keys(rows[0] ?? {});

    output.log("");

    printTable(output, {
      columns: columnKeys.map((key) => ({ key, label: key.toUpperCase() })),
      rows: rows.map((r) => {
        const row: Record<string, string> = {};
        for (const key of columnKeys) {
          const v = r[key];
          row[key] = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
        }
        return row;
      }),
    });

    output.log("");
    output.log(
      dim(`  ${bold(String(res.rows ?? rows.length))} row${(res.rows ?? rows.length) === 1 ? "" : "s"}`) +
      (res.statistics ? dim(` — ${(res.statistics.elapsed * 1000).toFixed(1)} ms`) : ""),
    );
    output.log("");
  });
