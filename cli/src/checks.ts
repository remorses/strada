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
import { printTable } from "./table.ts";

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
  .option("--url <url>", z.string().describe("URL to check (required)"))
  .option("--name <name>", z.string().describe("Human-readable check name (required)"))
  .option("--method <method>", z.enum(["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]).describe("HTTP method (default: GET)"))
  .option("--schedule <cron>", z.string().describe("Cron schedule in UTC (default: '*/5 * * * *')"))
  .option("--timeout <ms>", z.coerce.number().describe("Request timeout in ms (default: 10000)"))
  .option("--failures <count>", z.coerce.number().describe("Consecutive failures before alerting (default: 2)"))
  .option("--status-min <code>", z.coerce.number().describe("Min acceptable status code (default: 200)"))
  .option("--status-max <code>", z.coerce.number().describe("Max acceptable status code (default: 299)"))
  .option("--cooldown <minutes>", z.coerce.number().describe("Re-alert cooldown in minutes (default: 60)"))
  .option("--auto-disable-hours <hours>", z.coerce.number().describe("Auto-disable after N hours of failure, 0 to disable (default: 24)"))
  .option("--project <slug>", z.string().describe("Project slug to scope the check to"))
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
    output.log(dim(`ID: ${(res as { id: string }).id}`));
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

    const checks = (res as { checks: any[] }).checks;
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
        { key: "name", label: "NAME", color: bold },
        { key: "url", label: "URL" },
        { key: "method", label: "METHOD", color: dim },
        { key: "schedule", label: "SCHEDULE" },
        { key: "timeout", label: "TIMEOUT" },
        { key: "failures", label: "FAILURES" },
        { key: "enabled", label: "STATUS" },
        { key: "id", label: "ID", color: dim },
      ],
      rows: checks.map((c: any) => ({
        name: c.name,
        url: c.url,
        method: c.method,
        schedule: c.schedule ?? '*/5 * * * *',
        timeout: `${c.timeoutMs}ms`,
        failures: String(c.failureThreshold),
        enabled: c.enabled ? green("enabled") : red("disabled"),
        id: c.id,
      })),
    });

    output.log("");
  });

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
