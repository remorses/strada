// Health check CLI commands. Create, list, delete, enable, and view status
// of URL health checks. Health checks are a type of alert rule that fetch
// a URL on a schedule and alert when it fails consecutively.
//
// Config and runtime state live in D1 (alert_rule with type = 'health_check').
// Check results are append-only in ClickHouse (otel_health_checks).
//
// A Cloudflare Workflow runs the actual HTTP fetches every 5 minutes,
// with each tenant org as a separate durable step.

import { goke } from "goke";
import { z } from "zod";
import dedent from "string-dedent";
import { bold, cyan, dim, green, red, yellow } from "./colors.ts";
import { getApiClient } from "./api-client.ts";
import { ensureDefaultOrg, resolveProjectId } from "./projects.ts";
import { printTable, timeAgo } from "./table.ts";

export const checksCli = goke();

// ── checks create ──────────────────────────────────────────────

checksCli
  .command(
    "checks create",
    dedent`
      Create a URL health check that runs on a schedule.

      The check fetches the URL with the specified method and expects a status
      code in the configured range (default 200-299). After N consecutive
      failures (default 2), alerts fire to all configured destinations.

      Checks auto-disable after continuous failure for \`--auto-disable-hours\`
      (default 24) to avoid filling the database with identical failure rows.
      Re-enable with \`strada checks enable <id>\`.

      Alerts go to the same destinations as error alerts. If no destinations
      are configured, add one first with \`strada alerts create\`.
    `,
  )
  .option("--url <url>", z.string().describe("URL to check"))
  .required()
  .option("--name <name>", z.string().describe("Human-readable check name"))
  .required()
  .option("--method [method]", z.enum(["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]).describe("HTTP method (default: GET)"))
  .option("--schedule [cron]", z.string().describe("Cron schedule in UTC (default: '*/5 * * * *')"))
  .option("--timeout [ms]", z.coerce.number().describe("Request timeout in ms (default: 10000)"))
  .option("--failures [count]", z.coerce.number().describe("Consecutive failures before alerting (default: 2)"))
  .option("--status-min [code]", z.coerce.number().describe("Min acceptable status code (default: 200)"))
  .option("--status-max [code]", z.coerce.number().describe("Max acceptable status code (default: 299)"))
  .option("--cooldown [minutes]", z.coerce.number().describe("Re-alert cooldown in minutes (default: 60)"))
  .option("--auto-disable-hours [hours]", z.coerce.number().describe("Auto-disable after N hours of failure, 0 to disable (default: 24)"))
  .option("--project [slug]", z.string().describe("Project slug that stores the results (default: first project in the org)"))
  .action(async (options, { console: output, process: proc }) => {
    if (!options.url || !options.name) {
      output.log("Missing required options: --url <url> --name <name>");
      output.log(dim("Example: strada checks create --url https://api.example.com/health --name 'API health'"));
      return proc.exit(1);
    }

    const org = await ensureDefaultOrg();
    const { safeFetch } = getApiClient();

    let projectId: string | null = null;
    if (options.project) {
      const resolved = await resolveProjectId(org.id, options.project);
      projectId = resolved.id;
    }

    const res = await safeFetch("/api/v0/orgs/:orgId/checks", {
      method: "POST",
      params: { orgId: org.id },
      body: {
        name: options.name,
        url: options.url,
        method: options.method ?? "GET",
        schedule: options.schedule ?? '*/5 * * * *',
        timeoutMs: options.timeout ?? 10000,
        failureThreshold: options.failures ?? 2,
        expectedStatusMin: options.statusMin ?? 200,
        expectedStatusMax: options.statusMax ?? 299,
        cooldownMinutes: options.cooldown ?? 60,
        autoDisableAfterHours: options.autoDisableHours ?? 24,
        projectId,
      },
    });
    if (res instanceof Error) throw res;

    output.log(green(`Created health check ${cyan(options.name)}: ${options.url}`));
    output.log(dim(`ID: ${res.id}`));
    output.log(dim("The check will start running within 5 minutes."));
  });

// ── checks list ────────────────────────────────────────────────

checksCli
  .command(
    "checks list",
    dedent`
      List all health checks for the current org.

      Shows check name, URL, schedule, status, and whether it's enabled.
      Use \`strada checks delete <id>\` to remove a check.
    `,
  )
  .action(async (_options, { console: output }) => {
    const org = await ensureDefaultOrg();
    const { safeFetch } = getApiClient();

    const res = await safeFetch("/api/v0/orgs/:orgId/checks", {
      method: "GET",
      params: { orgId: org.id },
    });
    if (res instanceof Error) throw res;

    const checks = res.checks;
    if (checks.length === 0) {
      output.log(dim("No health checks configured."));
      output.log("");
      output.log(`Create one with: ${cyan("strada checks create --url https://... --name 'My check'")}`);
      return;
    }

    output.log("");
    output.log(bold(`Health checks for ${cyan(org.name)}`));
    output.log("");

    printTable(output, {
      columns: [
        { key: "state", label: "STATE" },
        { key: "name", label: "NAME", color: bold },
        { key: "url", label: "URL", maxWidth: 48 },
        { key: "last", label: "LAST RUN" },
        { key: "code", label: "CODE", align: "right" },
        { key: "latency", label: "LATENCY", align: "right" },
        { key: "uptime", label: "UPTIME 24H", align: "right" },
        { key: "schedule", label: "SCHEDULE", color: dim },
        { key: "project", label: "PROJECT", color: dim },
        { key: "id", label: "ID", color: dim },
      ],
      rows: checks.map((c) => {
        const s = c.summary;
        return {
          state: checkState(c),
          name: c.name,
          url: c.url ?? "",
          last: s ? timeAgo(new Date(s.lastCheckedAt).toISOString()) : dim("never"),
          code: s ? (s.lastStatusCode ? String(s.lastStatusCode) : dim("—")) : dim("—"),
          latency: s ? `${s.lastLatencyMs}ms` : dim("—"),
          uptime: s?.uptime24h != null ? formatUptime(s.uptime24h) : dim("—"),
          schedule: c.schedule,
          project: c.projectSlug ?? "",
          id: c.id,
        };
      }),
    });

    output.log("");
    output.log(dim("Run `strada checks view <id>` for recent results and failure details."));
  });

// ── checks view ────────────────────────────────────────────────

checksCli
  .command(
    "checks view <id>",
    dedent`
      Show the status and recent results of one health check.

      Prints the check config, current state (up, down, alerting, disabled),
      24h uptime, and a table of the most recent runs with status code,
      latency, and error message. For the latest failure it also prints the
      stored response body (truncated to 16KB by the worker), which usually
      explains why the endpoint is down.

      Get the check ID from \`strada checks list\`. Results come from the
      \`otel_health_checks\` table; use \`strada query\` for custom SQL.
    `,
  )
  .option("-n, --limit [count]", z.coerce.number().int().min(1).max(500).describe("Number of recent runs to show (default: 20)"))
  .option("--json", "Print raw JSON")
  .example("strada checks view 01M3BS7NRAP1WVD4DBQCM7X2T3")
  .example("strada checks view 01M3BS7NRAP1WVD4DBQCM7X2T3 -n 100")
  .action(async (id, options, { console: output, process: proc }) => {
    const org = await ensureDefaultOrg();
    const { safeFetch } = getApiClient();

    const [list, results] = await Promise.all([
      safeFetch("/api/v0/orgs/:orgId/checks", { method: "GET", params: { orgId: org.id } }),
      safeFetch("/api/v0/orgs/:orgId/checks/:checkId/results", {
        method: "GET",
        params: { orgId: org.id, checkId: id },
        query: { limit: options.limit ?? 20 },
      }),
    ]);
    if (list instanceof Error) throw list;
    if (results instanceof Error) throw results;

    const check = list.checks.find((c) => c.id === id);
    if (!check) {
      output.log(red(`Health check ${id} not found`));
      return proc.exit(1);
    }

    if (options.json) {
      output.log(JSON.stringify({ check, results: results.results }, null, 2));
      return;
    }

    const s = check.summary;
    output.log("");
    output.log(`${checkState(check)}  ${bold(check.name)}  ${dim(check.id)}`);
    output.log(`${dim("URL")}       ${check.method} ${check.url}`);
    output.log(`${dim("Schedule")}  ${check.schedule} UTC, timeout ${check.timeoutMs}ms, expects ${check.expectedStatusMin}-${check.expectedStatusMax}`);
    output.log(`${dim("Alerting")}  after ${check.failureThreshold} consecutive failures, cooldown ${check.cooldownMinutes}m, ${check.destinations.length} destination(s)`);
    if (check.projectSlug) output.log(`${dim("Project")}   ${check.projectSlug}`);
    if (s?.uptime24h != null) output.log(`${dim("Uptime")}    ${formatUptime(s.uptime24h)} over ${s.runs24h} runs in 24h`);
    if (check.firstFailedAt) output.log(`${dim("Failing")}   since ${timeAgo(new Date(check.firstFailedAt).toISOString())}`);
    if (check.destinations.length === 0) {
      output.log(yellow("No destinations: failures are recorded but no alert is sent. Add one with `strada alerts create`."));
    }
    output.log("");

    if (results.results.length === 0) {
      output.log(dim("No runs yet. Checks run on the next matching cron tick."));
      return;
    }

    printTable(output, {
      columns: [
        { key: "time", label: "TIME" },
        { key: "result", label: "RESULT" },
        { key: "code", label: "CODE", align: "right" },
        { key: "latency", label: "LATENCY", align: "right" },
        { key: "error", label: "ERROR", maxWidth: 60, color: red },
      ],
      rows: results.results.map((r) => ({
        time: new Date(r.timestamp).toISOString().replace("T", " ").slice(0, 19),
        result: r.success ? green("ok") : red("fail"),
        code: r.statusCode ? String(r.statusCode) : dim("—"),
        latency: `${r.latencyMs}ms`,
        error: r.errorMessage,
      })),
    });

    const lastFailure = results.results.find((r) => !r.success);
    if (lastFailure?.responseBody) {
      output.log("");
      output.log(bold("Last failure response body"));
      output.log(lastFailure.responseBody.slice(0, 2000));
    }
    output.log("");
  });

type CheckListItem = {
  enabled: boolean;
  disabledReason: string | null;
  alertStatus: string | null;
  summary: { lastSuccess: boolean } | null;
};

function checkState(c: CheckListItem): string {
  if (!c.enabled) return red(c.disabledReason === "auto" ? "auto-disabled" : "disabled");
  if (c.alertStatus === "alerting") return red("alerting");
  if (!c.summary) return dim("pending");
  return c.summary.lastSuccess ? green("up") : yellow("down");
}

function formatUptime(ratio: number): string {
  const text = `${(ratio * 100).toFixed(ratio === 1 ? 0 : 2)}%`;
  return ratio >= 0.99 ? green(text) : ratio >= 0.9 ? yellow(text) : red(text);
}

// ── checks delete ──────────────────────────────────────────────

checksCli
  .command(
    "checks delete <id>",
    dedent`
      Delete a health check by ID.

      Removes the check rule from D1. Historical check results remain in
      ClickHouse and are queryable via \`strada query\`.
    `,
  )
  .action(async (id, _options, { console: output }) => {
    const org = await ensureDefaultOrg();
    const { safeFetch } = getApiClient();

    const res = await safeFetch("/api/v0/orgs/:orgId/checks/:checkId", {
      method: "DELETE",
      params: { orgId: org.id, checkId: id },
    });
    if (res instanceof Error) throw res;

    output.log(green(`Health check ${cyan(id)} deleted`));
  });

// ── checks enable ──────────────────────────────────────────────

checksCli
  .command(
    "checks enable <id>",
    dedent`
      Re-enable a health check that was disabled (manually or auto-disabled).

      Auto-disabled checks stop running after continuous failure for too long.
      Re-enable them so they start checking again.
    `,
  )
  .action(async (id, _options, { console: output }) => {
    const org = await ensureDefaultOrg();
    const { safeFetch } = getApiClient();

    const res = await safeFetch("/api/v0/orgs/:orgId/checks/:checkId", {
      method: "PUT",
      params: { orgId: org.id, checkId: id },
      body: { enabled: true },
    });
    if (res instanceof Error) throw res;

    output.log(green(`Health check ${cyan(id)} enabled`));
  });

// ── checks disable ─────────────────────────────────────────────

checksCli
  .command(
    "checks disable <id>",
    dedent`
      Manually disable a health check.

      The check stops running but the rule is preserved. Re-enable with
      \`strada checks enable <id>\`.
    `,
  )
  .action(async (id, _options, { console: output }) => {
    const org = await ensureDefaultOrg();
    const { safeFetch } = getApiClient();

    const res = await safeFetch("/api/v0/orgs/:orgId/checks/:checkId", {
      method: "PUT",
      params: { orgId: org.id, checkId: id },
      body: { enabled: false },
    });
    if (res instanceof Error) throw res;

    output.log(yellow(`Health check ${cyan(id)} disabled`));
  });
