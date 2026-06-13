// Analytics CLI commands for browser pageview data and custom events.
// Queries the pre-aggregated materialized views (otel_analytics_pages,
// otel_analytics_sessions) and raw otel_traces/otel_logs for realtime
// and custom event data.
//
// All queries use uniqMerge/countMerge for AggregatingMergeTree tables.
// ProjectId is never referenced; the JWT filter handles it automatically.

import { goke, type GokeExecutionContext } from "goke";
import dedent from "string-dedent";
import { z } from "zod";

import { bold, cyan, dim, green, yellow, gray } from "./colors.ts";
import { resolveProjects } from "./projects.ts";
import { queryProject } from "./issues.ts";
import { printTable, formatCount, timeAgo } from "./table.ts";
import { parseDuration } from "./parse-duration.ts";

export const analyticsCli = goke();

// ── Shared helpers ────────────────────────────────────────────────

interface AnalyticsOptions {
  project?: string[];
  org?: string;
  service?: string;
  since?: string;
  limit?: string | number;
  domain?: string;
}

/** Build WHERE conditions shared by all analytics MV queries */
function buildMvConditions(opts: AnalyticsOptions): string[] {
  const since = parseDuration(opts.since || "7d");
  const conditions: string[] = [`Date >= today() - INTERVAL ${since}`];
  if (opts.service) conditions.push(`ServiceName = '${opts.service}'`);
  if (opts.domain) conditions.push(`Domain = '${opts.domain}'`);
  return conditions;
}

/** Resolve projects and query all in parallel */
async function queryAllProjects(options: AnalyticsOptions, sql: string) {
  const { slugs, projects } = await resolveProjects({ project: options.project, org: options.org });
  const results = await Promise.all(projects.map((p) => queryProject(p.id, sql)));
  return { slugs, rows: results.flatMap((data) => data.data ?? []) };
}

// ── Shared option factory ─────────────────────────────────────────

/** Create an analytics subcommand with the standard project/org/time/domain options pre-attached. */
function analyticsCommand(name: string, description: string) {
  return analyticsCli
    .command(name, description)
    .option("-p, --project <slug>", z.array(z.string()).describe("Project slug override (repeatable, defaults to folder setup)"))
    .option("--org [name-or-id]", "Organization override (defaults to folder setup)")
    .option("-s, --service [name]", "Filter by service name")
    .option("--since [duration]", "Time range, e.g. 1h, 24h, 7d (default: 7d)")
    .option("-n, --limit [count]", "Max number of rows (default: 20)")
    .option("--domain [domain]", "Filter by domain");
}

// ── analytics pages ───────────────────────────────────────────────

analyticsCommand(
  "analytics pages",
  dedent`
    Top pages by pageviews from the otel_analytics_pages materialized view.

    Shows pathname, pageview count, and unique visitor count. Uses
    countMerge/uniqMerge for AggregatingMergeTree columns.
  `,
)
  .example('strada analytics pages -p my-app --since 30d')
  .action(async (options: AnalyticsOptions, { console: output, process: proc }: GokeExecutionContext) => {
    const conditions = buildMvConditions(options);
    const limit = Number(options.limit) || 20;

    const sql = dedent`
      SELECT
          Pathname,
          countMerge(Hits) AS pageviews,
          uniqMerge(Visits) AS visitors
      FROM otel_analytics_pages
      WHERE ${conditions.join("\n  AND ")}
      GROUP BY Pathname
      ORDER BY pageviews DESC
      LIMIT ${limit}
    `.trim();

    const { slugs, rows } = await queryAllProjects(options, sql);

    if (rows.length === 0) {
      output.log(dim(`No pageview data in ${cyan(slugs.join(", "))} (last ${options.since || "7d"})`));
      return;
    }

    const sinceLabel = options.since || "7d";
    output.log("");
    output.log(bold(`Top pages in ${cyan(slugs.join(", "))}`) + dim(` (last ${sinceLabel})`));
    output.log("");

    printTable(output, {
      columns: [
        { key: "pathname", label: "PATHNAME", color: cyan },
        { key: "pageviews", label: "PAGEVIEWS", align: "right", color: bold },
        { key: "visitors", label: "VISITORS", align: "right" },
      ],
      rows: rows.map((r) => ({
        pathname: String(r.Pathname ?? ""),
        pageviews: formatCount(Number(r.pageviews ?? 0)),
        visitors: formatCount(Number(r.visitors ?? 0)),
      })),
    });

    output.log("");
  });

// ── analytics browsers ────────────────────────────────────────────

analyticsCommand("analytics browsers", "Top browsers by unique visitors")
  .action(async (options: AnalyticsOptions, { console: output, process: proc }: GokeExecutionContext) => {
    const conditions = buildMvConditions(options);
    const limit = Number(options.limit) || 20;

    const sql = dedent`
      SELECT
          Browser,
          uniqMerge(Visits) AS visitors,
          countMerge(Hits) AS pageviews
      FROM otel_analytics_pages
      WHERE ${conditions.join("\n  AND ")}
      GROUP BY Browser
      ORDER BY visitors DESC
      LIMIT ${limit}
    `.trim();

    const { slugs, rows } = await queryAllProjects(options, sql);

    if (rows.length === 0) {
      output.log(dim(`No browser data in ${cyan(slugs.join(", "))} (last ${options.since || "7d"})`));
      return;
    }

    output.log("");
    output.log(bold(`Top browsers in ${cyan(slugs.join(", "))}`) + dim(` (last ${options.since || "7d"})`));
    output.log("");

    printTable(output, {
      columns: [
        { key: "browser", label: "BROWSER", color: cyan },
        { key: "visitors", label: "VISITORS", align: "right", color: bold },
        { key: "pageviews", label: "PAGEVIEWS", align: "right" },
      ],
      rows: rows.map((r) => ({
        browser: String(r.Browser ?? "Unknown"),
        visitors: formatCount(Number(r.visitors ?? 0)),
        pageviews: formatCount(Number(r.pageviews ?? 0)),
      })),
    });

    output.log("");
  });

// ── analytics devices ─────────────────────────────────────────────

analyticsCommand("analytics devices", "Top device types by unique visitors")
  .action(async (options: AnalyticsOptions, { console: output, process: proc }: GokeExecutionContext) => {
    const conditions = buildMvConditions(options);
    const limit = Number(options.limit) || 20;

    const sql = dedent`
      SELECT
          Device,
          uniqMerge(Visits) AS visitors,
          countMerge(Hits) AS pageviews
      FROM otel_analytics_pages
      WHERE ${conditions.join("\n  AND ")}
      GROUP BY Device
      ORDER BY visitors DESC
      LIMIT ${limit}
    `.trim();

    const { slugs, rows } = await queryAllProjects(options, sql);

    if (rows.length === 0) {
      output.log(dim(`No device data in ${cyan(slugs.join(", "))} (last ${options.since || "7d"})`));
      return;
    }

    output.log("");
    output.log(bold(`Top devices in ${cyan(slugs.join(", "))}`) + dim(` (last ${options.since || "7d"})`));
    output.log("");

    printTable(output, {
      columns: [
        { key: "device", label: "DEVICE", color: cyan },
        { key: "visitors", label: "VISITORS", align: "right", color: bold },
        { key: "pageviews", label: "PAGEVIEWS", align: "right" },
      ],
      rows: rows.map((r) => ({
        device: String(r.Device ?? "Unknown"),
        visitors: formatCount(Number(r.visitors ?? 0)),
        pageviews: formatCount(Number(r.pageviews ?? 0)),
      })),
    });

    output.log("");
  });

// ── analytics countries ───────────────────────────────────────────

analyticsCommand("analytics countries", "Top countries by unique visitors")
  .action(async (options: AnalyticsOptions, { console: output, process: proc }: GokeExecutionContext) => {
    const conditions = buildMvConditions(options);
    const limit = Number(options.limit) || 20;

    const sql = dedent`
      SELECT
          Country,
          uniqMerge(Visits) AS visitors,
          countMerge(Hits) AS pageviews
      FROM otel_analytics_pages
      WHERE ${conditions.join("\n  AND ")}
      GROUP BY Country
      ORDER BY visitors DESC
      LIMIT ${limit}
    `.trim();

    const { slugs, rows } = await queryAllProjects(options, sql);

    if (rows.length === 0) {
      output.log(dim(`No country data in ${cyan(slugs.join(", "))} (last ${options.since || "7d"})`));
      return;
    }

    output.log("");
    output.log(bold(`Top countries in ${cyan(slugs.join(", "))}`) + dim(` (last ${options.since || "7d"})`));
    output.log("");

    printTable(output, {
      columns: [
        { key: "country", label: "COUNTRY", color: cyan },
        { key: "visitors", label: "VISITORS", align: "right", color: bold },
        { key: "pageviews", label: "PAGEVIEWS", align: "right" },
      ],
      rows: rows.map((r) => ({
        country: String(r.Country ?? "Unknown"),
        visitors: formatCount(Number(r.visitors ?? 0)),
        pageviews: formatCount(Number(r.pageviews ?? 0)),
      })),
    });

    output.log("");
  });

// ── analytics referrers ───────────────────────────────────────────

analyticsCommand("analytics referrers", "Top traffic sources by unique visitors")
  .action(async (options: AnalyticsOptions, { console: output, process: proc }: GokeExecutionContext) => {
    const conditions = buildMvConditions(options);
    conditions.push(`Referrer != ''`);
    if (options.domain) {
      conditions.push(`Referrer != '${options.domain}'`);
    }
    const limit = Number(options.limit) || 20;

    const sql = dedent`
      SELECT
          Referrer,
          uniqMerge(Visits) AS visitors,
          countMerge(Hits) AS pageviews
      FROM otel_analytics_pages
      WHERE ${conditions.join("\n  AND ")}
      GROUP BY Referrer
      ORDER BY visitors DESC
      LIMIT ${limit}
    `.trim();

    const { slugs, rows } = await queryAllProjects(options, sql);

    if (rows.length === 0) {
      output.log(dim(`No referrer data in ${cyan(slugs.join(", "))} (last ${options.since || "7d"})`));
      return;
    }

    output.log("");
    output.log(bold(`Top referrers in ${cyan(slugs.join(", "))}`) + dim(` (last ${options.since || "7d"})`));
    output.log("");

    printTable(output, {
      columns: [
        { key: "referrer", label: "REFERRER", color: cyan },
        { key: "visitors", label: "VISITORS", align: "right", color: bold },
        { key: "pageviews", label: "PAGEVIEWS", align: "right" },
      ],
      rows: rows.map((r) => ({
        referrer: String(r.Referrer ?? ""),
        visitors: formatCount(Number(r.visitors ?? 0)),
        pageviews: formatCount(Number(r.pageviews ?? 0)),
      })),
    });

    output.log("");
  });

// ── analytics languages ───────────────────────────────────────────

analyticsCommand("analytics languages", "Top browser languages by unique visitors")
  .action(async (options: AnalyticsOptions, { console: output, process: proc }: GokeExecutionContext) => {
    const conditions = buildMvConditions(options);
    const limit = Number(options.limit) || 20;

    const sql = dedent`
      SELECT
          Language,
          uniqMerge(Visits) AS visitors,
          countMerge(Hits) AS pageviews
      FROM otel_analytics_pages
      WHERE ${conditions.join("\n  AND ")}
      GROUP BY Language
      ORDER BY visitors DESC
      LIMIT ${limit}
    `.trim();

    const { slugs, rows } = await queryAllProjects(options, sql);

    if (rows.length === 0) {
      output.log(dim(`No language data in ${cyan(slugs.join(", "))} (last ${options.since || "7d"})`));
      return;
    }

    output.log("");
    output.log(bold(`Top languages in ${cyan(slugs.join(", "))}`) + dim(` (last ${options.since || "7d"})`));
    output.log("");

    printTable(output, {
      columns: [
        { key: "language", label: "LANGUAGE", color: cyan },
        { key: "visitors", label: "VISITORS", align: "right", color: bold },
        { key: "pageviews", label: "PAGEVIEWS", align: "right" },
      ],
      rows: rows.map((r) => ({
        language: String(r.Language ?? "Unknown"),
        visitors: formatCount(Number(r.visitors ?? 0)),
        pageviews: formatCount(Number(r.pageviews ?? 0)),
      })),
    });

    output.log("");
  });

// ── analytics kpis ────────────────────────────────────────────────

analyticsCommand(
  "analytics kpis",
  dedent`
    Summary KPIs: unique visitors, pageviews, sessions, bounce rate, and
    average session duration.

    Queries both otel_analytics_pages and otel_analytics_sessions MVs.
    This gives a quick health check of browser analytics data.
  `,
)
  .example('strada analytics kpis -p my-app --since 30d')
  .action(async (options: AnalyticsOptions, { console: output, process: proc }: GokeExecutionContext) => {
    const pagesConditions = buildMvConditions(options);
    const sessionsConditions = buildMvConditions(options);

    const pagesSql = dedent`
      SELECT
          uniqMerge(Visits) AS unique_visitors,
          countMerge(Hits) AS total_pageviews
      FROM otel_analytics_pages
      WHERE ${pagesConditions.join("\n  AND ")}
    `.trim();

    // SimpleAggregateFunction(max/min, DateTime64) columns can't be subtracted
    // directly. Convert to milliseconds via toUnixTimestamp64Milli, then diff.
    const sessionsSql = dedent`
      SELECT
          count() AS total_sessions,
          sumIf(1, latest_ms = first_ms) / greatest(count(), 1) AS bounce_rate,
          avg(latest_ms - first_ms) / 1000 AS avg_session_duration_sec
      FROM (
          SELECT
              SessionId,
              toUnixTimestamp64Milli(max(LatestHit)) AS latest_ms,
              toUnixTimestamp64Milli(min(FirstHit)) AS first_ms
          FROM otel_analytics_sessions
          WHERE ${sessionsConditions.join("\n      AND ")}
          GROUP BY SessionId
      )
    `.trim();

    const { slugs, projects } = await resolveProjects({ project: options.project, org: options.org });

    // Query pages and sessions MVs in parallel across all projects
    const [pagesResults, sessionsResults] = await Promise.all([
      Promise.all(projects.map((p) => queryProject(p.id, pagesSql))),
      Promise.all(projects.map((p) => queryProject(p.id, sessionsSql))),
    ]);

    const pagesRows = pagesResults.flatMap((d) => d.data ?? []);
    const sessionsRows = sessionsResults.flatMap((d) => d.data ?? []);

    // Sum across projects
    let visitors = 0;
    let pageviews = 0;
    for (const r of pagesRows) {
      visitors += Number(r.unique_visitors ?? 0);
      pageviews += Number(r.total_pageviews ?? 0);
    }

    let sessions = 0;
    let bounceRate = 0;
    let avgDuration = 0;
    for (const r of sessionsRows) {
      sessions += Number(r.total_sessions ?? 0);
      bounceRate = Number(r.bounce_rate ?? 0); // last project wins (usually single project)
      avgDuration = Number(r.avg_session_duration_sec ?? 0);
    }

    const sinceLabel = options.since || "7d";
    output.log("");
    output.log(bold(`KPIs for ${cyan(slugs.join(", "))}`) + dim(` (last ${sinceLabel})`));
    output.log("");

    const labelWidth = 16;
    const kv = (label: string, value: string) =>
      `  ${dim(label.padEnd(labelWidth))}${bold(value)}`;

    output.log(kv("Visitors", formatCount(visitors)));
    output.log(kv("Pageviews", formatCount(pageviews)));
    output.log(kv("Sessions", formatCount(sessions)));
    output.log(kv("Bounce rate", `${(bounceRate * 100).toFixed(1)}%`));
    output.log(kv("Avg duration", formatDuration(avgDuration)));
    output.log("");
  });

// ── analytics events ──────────────────────────────────────────────

analyticsCommand("analytics events", "Top custom events by occurrence count")
  .option("-w, --where <expr>", z.array(z.string()).describe("Raw SQL WHERE condition (repeatable, ANDed)"))
  .action(async (options: AnalyticsOptions & { where?: string[] }, { console: output, process: proc }: GokeExecutionContext) => {
    const since = parseDuration(options.since || "7d");
    const limit = Number(options.limit) || 20;

    const conditions = [`Timestamp >= now() - INTERVAL ${since}`, `LogAttributes['event.name'] != ''`];
    if (options.service) conditions.push(`ServiceName = '${options.service}'`);
    if (options.where) for (const w of options.where) conditions.push(w);

    const sql = dedent`
      SELECT
          LogAttributes['event.name'] AS event_name,
          count() AS occurrences,
          uniqExact(LogAttributes['session.id']) AS unique_sessions
      FROM otel_logs
      WHERE ${conditions.join("\n  AND ")}
      GROUP BY event_name
      ORDER BY occurrences DESC
      LIMIT ${limit}
    `.trim();

    const { slugs, rows } = await queryAllProjects(options, sql);

    if (rows.length === 0) {
      output.log(dim(`No custom events in ${cyan(slugs.join(", "))} (last ${options.since || "7d"})`));
      return;
    }

    output.log("");
    output.log(bold(`Top events in ${cyan(slugs.join(", "))}`) + dim(` (last ${options.since || "7d"})`));
    output.log("");

    printTable(output, {
      columns: [
        { key: "event", label: "EVENT", color: cyan },
        { key: "occurrences", label: "COUNT", align: "right", color: bold },
        { key: "sessions", label: "SESSIONS", align: "right" },
      ],
      rows: rows.map((r) => ({
        event: String(r.event_name ?? ""),
        occurrences: formatCount(Number(r.occurrences ?? 0)),
        sessions: formatCount(Number(r.unique_sessions ?? 0)),
      })),
    });

    output.log("");
  });

// ── analytics realtime ────────────────────────────────────────────

analyticsCli
  .command(
    "analytics realtime",
    dedent`
      Count active visitors in the last 5 minutes.

      Queries raw otel_traces for pageview spans with distinct session.id
      values. This is a real-time metric, not from the materialized views.
    `,
  )
  .option("-p, --project <slug>", z.array(z.string()).describe("Project slug override (repeatable, defaults to folder setup)"))
  .option("--org [name-or-id]", "Organization override (defaults to folder setup)")
  .option("-s, --service [name]", "Filter by service name")
  .option("--domain [domain]", "Filter by domain")
  .action(async (options: AnalyticsOptions, { console: output, process: proc }: GokeExecutionContext) => {
    const conditions = [
      `SpanName = 'pageview'`,
      `Timestamp >= now() - INTERVAL 5 MINUTE`,
    ];
    if (options.service) conditions.push(`ServiceName = '${options.service}'`);

    const sql = dedent`
      SELECT uniq(SpanAttributes['session.id']) AS active_visitors
      FROM otel_traces
      WHERE ${conditions.join("\n  AND ")}
    `.trim();

    const { rows } = await queryAllProjects(options, sql);
    const active = rows.reduce((sum, r) => sum + Number(r.active_visitors ?? 0), 0);

    output.log("");
    output.log(`  ${dim("Active visitors:")} ${bold(green(formatCount(active)))}`);
    output.log("");
  });

// ── Helpers ───────────────────────────────────────────────────────

/** Format seconds into human-readable duration: "2m 34s", "1h 12m" */
function formatDuration(seconds: number): string {
  if (seconds < 0 || Number.isNaN(seconds)) return "0s";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remainS = s % 60;
  if (m < 60) return remainS > 0 ? `${m}m ${remainS}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remainM = m % 60;
  return remainM > 0 ? `${h}h ${remainM}m` : `${h}h`;
}
