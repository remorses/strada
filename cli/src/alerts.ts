// Alert rule CRUD commands. Create, list, update, delete error alert rules.
// Multiple rules per org are supported. Project-scoped rules override
// org-wide rules for the same project (dedup handled by the cron).
//
// Destinations are managed separately via `strada destinations`.
// Creating a rule with --channel/--to creates a destination inline
// and auto-links all existing org destinations to the new rule.

import { goke } from "goke";
import { z } from "zod";
import dedent from "string-dedent";
import { bold, cyan, dim, green, red, yellow } from "./colors.ts";
import { getApiClient } from "./api-client.ts";
import { ensureDefaultOrg, resolveProjectId } from "./projects.ts";
import { printTable } from "./table.ts";

export const alertsCli = goke();

// ── alerts create ────────────────────────────────────────────────

alertsCli
  .command(
    "alerts create",
    dedent`
      Create an error alert rule.

      Alert when errors of the same fingerprint exceed a threshold within
      a time window. Multiple rules per org are supported. Project-scoped
      rules override org-wide rules for the same project.

      Optionally pass --channel and --to to create a destination inline.
      All existing org destinations are auto-linked to the new rule.
    `,
  )
  .option("--name <name>", z.string().describe("Rule name (required)"))
  .option("--project <slug>", z.string().describe("Scope to a project (omit for all projects)"))
  .option("--threshold <count>", z.coerce.number().describe("Min errors to trigger (default: 1)"))
  .option("--window <minutes>", z.coerce.number().describe("Time window in minutes (default: 5)"))
  .option("--cooldown <minutes>", z.coerce.number().describe("Re-alert cooldown in minutes (default: 60)"))
  .option("--channel <type>", z.enum(["email", "webhook", "slack"]).describe("Create a destination inline"))
  .option("--to <destination>", z.string().describe("Email address or webhook URL"))
  .action(async (options, { console: output, process: proc }) => {
    if (!options.name) {
      output.log("Missing required option: --name <name>");
      output.log(dim("Example: strada alerts create --name 'API errors' --project api"));
      return proc.exit(1);
    }

    const hasChannel = options.channel != null;
    const hasTo = options.to != null;
    if (hasChannel !== hasTo) {
      output.log("--channel and --to must be provided together.");
      output.log(dim("Example: strada alerts create --name 'My alerts' --channel email --to you@example.com"));
      return proc.exit(1);
    }

    const org = await ensureDefaultOrg();
    const { safeFetch } = getApiClient();

    let projectId: string | null = null;
    if (options.project) {
      const resolved = await resolveProjectId(org.id, options.project);
      projectId = resolved.id;
    }

    const body: Record<string, unknown> = {
      name: options.name,
      projectId,
      errorThreshold: options.threshold ?? 1,
      errorWindowMinutes: options.window ?? 5,
      cooldownMinutes: options.cooldown ?? 60,
    };
    if (options.channel && options.to) {
      body.channel = options.channel;
      body.destination = options.to;
    }

    const res = await safeFetch("/api/v0/orgs/:orgId/alerts", {
      method: "POST",
      params: { orgId: org.id },
      body,
    });
    if (res instanceof Error) throw res;

    const scopeLabel = projectId
      ? `project ${cyan(options.project || projectId)}`
      : "all projects";
    output.log(green(`Created alert rule ${cyan(options.name)} (${scopeLabel})`));
    output.log(dim(`ID: ${(res as { id: string }).id}`));

    if (options.channel && options.to) {
      output.log(dim(`Destination: ${options.channel} → ${options.to}`));
    }
  });

// ── alerts list ──────────────────────────────────────────────────

alertsCli
  .command(
    "alerts list",
    dedent`
      Show all alert rules and destinations for the current org.

      Lists both error_threshold and health_check rules with their
      destinations. Use \`strada checks list\` to see health check details.
    `,
  )
  .action(async (_options, { console: output }) => {
    const org = await ensureDefaultOrg();
    const { safeFetch } = getApiClient();

    const [alertsRes, destsRes] = await Promise.all([
      safeFetch("/api/v0/orgs/:orgId/alerts", {
        method: "GET",
        params: { orgId: org.id },
      }),
      safeFetch("/api/v0/orgs/:orgId/destinations", {
        method: "GET",
        params: { orgId: org.id },
      }),
    ]);
    if (alertsRes instanceof Error) throw alertsRes;
    if (destsRes instanceof Error) throw destsRes;

    const rules = (alertsRes as { rules: any[] }).rules;
    const allDests = (destsRes as { destinations: any[] }).destinations;

    if (rules.length === 0 && allDests.length === 0) {
      output.log(dim("No alert rules or destinations configured."));
      output.log("");
      output.log(`Create one with: ${cyan("strada alerts create --name 'My alerts' --channel email --to you@example.com")}`);
      return;
    }

    output.log("");
    output.log(bold(`Alert rules for ${cyan(org.name)}`));
    output.log("");

    // Separate by type
    const errorRules = rules.filter((r: any) => r.type === "error_threshold");
    const checkRules = rules.filter((r: any) => r.type === "health_check");

    if (errorRules.length > 0) {
      output.log(bold("  Error alerts"));
      output.log("");
      printTable(output, {
        columns: [
          { key: "name", label: "NAME", color: bold },
          { key: "project", label: "PROJECT" },
          { key: "threshold", label: "THRESHOLD" },
          { key: "window", label: "WINDOW" },
          { key: "cooldown", label: "COOLDOWN" },
          { key: "id", label: "ID", color: dim },
        ],
        rows: errorRules.map((r: any) => ({
          name: r.name,
          project: r.projectSlug ?? dim("all"),
          threshold: String(r.errorThreshold ?? 1),
          window: `${r.errorWindowMinutes ?? 5}m`,
          cooldown: `${r.cooldownMinutes ?? 60}m`,
          id: r.id,
        })),
      });
      output.log("");
    }

    if (checkRules.length > 0) {
      output.log(bold("  Health checks"));
      output.log("");
      printTable(output, {
        columns: [
          { key: "name", label: "NAME", color: bold },
          { key: "url", label: "URL" },
          { key: "schedule", label: "SCHEDULE" },
          { key: "id", label: "ID", color: dim },
        ],
        rows: checkRules.map((r: any) => ({
          name: r.name,
          url: r.checkUrl ?? "",
          schedule: r.checkSchedule ?? '*/5 * * * *',
          id: r.id,
        })),
      });
      output.log("");
    }

    if (allDests.length > 0) {
      output.log(bold("  Destinations"));
      output.log("");
      printTable(output, {
        columns: [
          { key: "channel", label: "CHANNEL", color: cyan },
          { key: "destination", label: "DESTINATION" },
          { key: "id", label: "ID", color: dim },
        ],
        rows: allDests,
      });
    }

    output.log("");
  });

// ── alerts update ────────────────────────────────────────────────

alertsCli
  .command(
    "alerts update <id>",
    dedent`
      Update an error alert rule's settings.

      Change the threshold, window, cooldown, or name of an existing
      error_threshold rule. Get the rule ID from \`strada alerts list\`.
    `,
  )
  .option("--name <name>", z.string().describe("New rule name"))
  .option("--threshold <count>", z.coerce.number().describe("Min errors to trigger"))
  .option("--window <minutes>", z.coerce.number().describe("Time window in minutes"))
  .option("--cooldown <minutes>", z.coerce.number().describe("Re-alert cooldown in minutes"))
  .action(async (id, options, { console: output }) => {
    const org = await ensureDefaultOrg();
    const { safeFetch } = getApiClient();

    const body: Record<string, unknown> = {};
    if (options.name != null) body.name = options.name;
    if (options.threshold != null) body.errorThreshold = options.threshold;
    if (options.window != null) body.errorWindowMinutes = options.window;
    if (options.cooldown != null) body.cooldownMinutes = options.cooldown;

    if (Object.keys(body).length === 0) {
      output.log(dim("Nothing to update. Pass --threshold, --window, --cooldown, or --name."));
      return;
    }

    const res = await safeFetch("/api/v0/orgs/:orgId/alerts/:ruleId", {
      method: "PUT",
      params: { orgId: org.id, ruleId: id },
      body,
    });
    if (res instanceof Error) throw res;

    output.log(green(`Alert rule ${cyan(id)} updated`));
  });

// ── alerts delete ────────────────────────────────────────────────

alertsCli
  .command(
    "alerts delete <id>",
    dedent`
      Delete an error alert rule.

      Destinations are not deleted; they remain for other rules.
      Get the rule ID from \`strada alerts list\`.
    `,
  )
  .action(async (id, _options, { console: output }) => {
    const org = await ensureDefaultOrg();
    const { safeFetch } = getApiClient();

    const res = await safeFetch("/api/v0/orgs/:orgId/alerts/:ruleId", {
      method: "DELETE",
      params: { orgId: org.id, ruleId: id },
    });
    if (res instanceof Error) throw res;

    output.log(green(`Alert rule ${cyan(id)} deleted`));
  });

// ── alerts test ──────────────────────────────────────────────────

alertsCli
  .command(
    "alerts test",
    dedent`
      Send a test alert to all destinations in the org.

      Verifies that each destination (email, webhook) is reachable.
    `,
  )
  .action(async (_options, { console: output }) => {
    const org = await ensureDefaultOrg();
    const { safeFetch } = getApiClient();

    const res = await safeFetch("/api/v0/orgs/:orgId/alerts/test", {
      method: "POST",
      params: { orgId: org.id },
      body: {},
    });
    if (res instanceof Error) throw res;

    for (const r of (res as { results: Array<{ channel: string; destination: string; ok: boolean }> }).results) {
      if (r.ok) {
        output.log(green(`  ✓ ${r.channel} → ${r.destination}`));
      } else {
        output.log(red(`  ✗ ${r.channel} → ${r.destination}`));
      }
    }
  });
