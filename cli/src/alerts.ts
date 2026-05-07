// Alert management CLI commands. Configure error alert rules and
// notification destinations (email, webhook, slack, agent) for an org.
//
// Multiple rules per org, each typed (error_threshold, health_check).
// Destinations are org-scoped and linked to rules many-to-many.
// The website cron checks errors every 5 minutes and sends notifications
// when thresholds are exceeded.

import { goke } from "goke";
import { z } from "zod";
import { bold, cyan, dim, green, red, yellow } from "./colors.ts";
import { getApiClient } from "./api-client.ts";
import { ensureDefaultOrg } from "./projects.ts";
import { printTable } from "./table.ts";

export const alertsCli = goke();

// ── alerts list ──────────────────────────────────────────────────

alertsCli
  .command("alerts list", "Show alert rule and destinations for the current org")
  .action(async (_options, { console: output }) => {
    const org = await ensureDefaultOrg();
    const { safeFetch } = getApiClient();

    const res = await safeFetch("/api/v0/orgs/:orgId/alerts", {
      method: "GET",
      params: { orgId: org.id },
    });
    if (res instanceof Error) throw res;

    if (!res.rule) {
      output.log(dim("No alert rule configured. Add one with:"));
      output.log("");
      output.log(`  ${cyan("strada alerts add")} --channel email --to you@example.com`);
      output.log("");
      return;
    }

    output.log("");
    output.log(bold(`Alert rule for ${cyan(org.name)}`));
    output.log(`  ${dim("Name")}         ${res.rule.name}`);
    output.log(`  ${dim("Type")}         ${res.rule.type}`);
    output.log("");
    output.log(`  ${dim("Threshold")}    ${bold(String(res.rule.errorThreshold ?? 1))} errors in ${bold(String(res.rule.errorWindowMinutes ?? 5))} minutes`);
    output.log(`  ${dim("Cooldown")}     ${bold(String(res.rule.cooldownMinutes))} minutes`);
    output.log("");

    if (res.destinations.length === 0) {
      output.log(dim("  No destinations configured."));
    } else {
      printTable(output, {
        columns: [
          { key: "channel", label: "CHANNEL", color: cyan },
          { key: "destination", label: "DESTINATION" },
          { key: "id", label: "ID", color: dim },
        ],
        rows: res.destinations.map((d: { id: string; channel: string; destination: string }) => ({
          channel: d.channel,
          destination: d.destination,
          id: d.id,
        })),
      });
    }

    output.log("");
  });

// ── alerts add ───────────────────────────────────────────────────

alertsCli
  .command("alerts add", "Add an alert destination (creates error_threshold rule if needed)")
  .option("--channel <type>", z.enum(["email", "webhook", "slack", "agent"]).describe("Notification channel"))
  .option("--to <destination>", "Email address, webhook URL, slack webhook URL, or agent endpoint")
  .option("--threshold [count]", "Min errors to trigger (default: 1)")
  .option("--window [minutes]", "Time window in minutes (default: 5)")
  .option("--cooldown [minutes]", "Re-alert cooldown in minutes (default: 60)")
  .action(async (options, { console: output, process: proc }) => {
    if (!options.channel || !options.to) {
      output.log("Missing required options: --channel <email|webhook|slack|agent> --to <destination>");
      output.log(dim("Example: strada alerts add --channel email --to you@example.com"));
      return proc.exit(1);
    }

    const org = await ensureDefaultOrg();
    const { safeFetch } = getApiClient();

    const body = {
      channel: options.channel,
      destination: options.to,
      ...(options.threshold ? { errorThreshold: Number(options.threshold) } : {}),
      ...(options.window ? { errorWindowMinutes: Number(options.window) } : {}),
      ...(options.cooldown ? { cooldownMinutes: Number(options.cooldown) } : {}),
    };

    const res = await safeFetch("/api/v0/orgs/:orgId/alerts/destinations", {
      method: "POST",
      params: { orgId: org.id },
      body,
    });
    if (res instanceof Error) throw res;

    output.log(green(`Added ${cyan(options.channel)} destination: ${options.to}`));
  });

// ── alerts set ───────────────────────────────────────────────────

alertsCli
  .command("alerts set", "Update error alert rule thresholds")
  .option("--threshold [count]", "Min errors to trigger")
  .option("--window [minutes]", "Time window in minutes")
  .option("--cooldown [minutes]", "Re-alert cooldown in minutes")
  .action(async (options, { console: output, process: proc }) => {
    if (!options.threshold && !options.window && !options.cooldown) {
      output.log("Specify at least one: --threshold, --window, or --cooldown");
      return proc.exit(1);
    }

    const org = await ensureDefaultOrg();
    const { safeFetch } = getApiClient();

    const body: Record<string, unknown> = {};
    if (options.threshold) body.errorThreshold = Number(options.threshold);
    if (options.window) body.errorWindowMinutes = Number(options.window);
    if (options.cooldown) body.cooldownMinutes = Number(options.cooldown);

    const res = await safeFetch("/api/v0/orgs/:orgId/alerts", {
      method: "PUT",
      params: { orgId: org.id },
      body,
    });
    if (res instanceof Error) throw res;

    output.log(green("Alert rule updated"));
  });

// ── alerts remove ────────────────────────────────────────────────

alertsCli
  .command("alerts remove <destinationId>", "Remove an alert destination by ID")
  .action(async (destinationId, _options, { console: output }) => {
    const org = await ensureDefaultOrg();
    const { safeFetch } = getApiClient();

    const res = await safeFetch("/api/v0/orgs/:orgId/alerts/destinations/:destinationId", {
      method: "DELETE",
      params: { orgId: org.id, destinationId },
    });
    if (res instanceof Error) throw res;

    output.log(green(`Destination ${cyan(destinationId)} removed`));
  });

// ── alerts test ──────────────────────────────────────────────────

alertsCli
  .command("alerts test", "Send a test alert to all destinations")
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
