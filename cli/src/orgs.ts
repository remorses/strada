// Org management CLI commands. List and switch between organizations.
//
// The current org is stored in ~/.strada/config.json as `currentOrgId`.
// When unset, commands fall back to the ensure-default behavior (first org
// or auto-create "Personal"). Use `strada orgs switch` to change it.

import * as clack from "@clack/prompts";
import { goke } from "goke";
import { bold, cyan, dim, green } from "./colors.ts";
import { loadConfig, updateConfig } from "./config.ts";
import { getApiClient } from "./api-client.ts";

export const orgsCli = goke();

interface OrgInfo {
  id: string;
  name: string;
  role: string;
}

async function fetchOrgs(): Promise<OrgInfo[]> {
  const { safeFetch } = getApiClient();
  const res = await safeFetch("/api/v0/orgs");
  if (res instanceof Error) throw res;
  return res.orgs;
}

/**
 * Resolve the current org. If `currentOrgId` is set in config, validate it
 * against the user's memberships. Otherwise fall back to ensure-default.
 */
export async function resolveCurrentOrg(): Promise<OrgInfo> {
  const config = loadConfig();

  if (config.currentOrgId) {
    const orgs = await fetchOrgs();
    const match = orgs.find((o) => o.id === config.currentOrgId);
    if (match) return match;
    // Stale currentOrgId (user removed from org, org deleted, etc.). Clear it
    // and fall through to ensure-default.
    updateConfig({ currentOrgId: undefined });
  }

  const { safeFetch } = getApiClient();
  const res = await safeFetch("/api/v0/orgs/ensure-default", { method: "POST" });
  if (res instanceof Error) throw res;
  return { id: res.id, name: res.name, role: "admin" };
}

orgsCli
  .command("orgs list", "List all organizations you belong to")
  .action(async (_options, { console: output }) => {
    const orgs = await fetchOrgs();
    const currentOrgId = loadConfig().currentOrgId;

    if (orgs.length === 0) {
      output.log("No organizations found. Run any command to auto-create a Personal org.");
      return;
    }

    output.log(bold("Organizations:"));
    output.log("");
    for (const org of orgs) {
      const isCurrent = org.id === currentOrgId || (!currentOrgId && orgs.length === 1);
      const marker = isCurrent ? green("● ") : "  ";
      const role = dim(`(${org.role})`);
      output.log(`${marker}${cyan(org.name)} ${role} ${dim(org.id)}`);
    }

    if (!currentOrgId && orgs.length > 1) {
      output.log("");
      output.log(dim("No org selected. Run `strada orgs switch` to pick one."));
    }
  });

orgsCli
  .command("orgs switch [name]", "Switch to a different organization")
  .action(async (name, _options, { console: output, process: proc }) => {
    const orgs = await fetchOrgs();

    if (orgs.length === 0) {
      output.log("No organizations found.");
      return proc.exit(1);
    }

    let selected: OrgInfo | undefined;

    if (name) {
      // Match by name (case-insensitive) or by ID
      selected = orgs.find(
        (o) => o.name.toLowerCase() === name.toLowerCase() || o.id === name,
      );
      if (!selected) {
        clack.log.error(`Organization "${name}" not found.`);
        output.log("");
        output.log("Available orgs:");
        for (const org of orgs) {
          output.log(`  ${cyan(org.name)} ${dim(org.id)}`);
        }
        return proc.exit(1);
      }
    } else if (!process.stdin.isTTY) {
      clack.log.error("Org name or ID required in non-interactive mode.");
      output.log("Usage: strada orgs switch <name-or-id>");
      return proc.exit(1);
    } else {
      const choice = await clack.select({
        message: "Select an organization",
        options: orgs.map((o) => ({
          value: o.id,
          label: o.name,
          hint: `${o.role} · ${o.id}`,
        })),
      });
      if (clack.isCancel(choice)) {
        clack.outro("Cancelled");
        return proc.exit(0);
      }
      selected = orgs.find((o) => o.id === choice);
    }

    if (!selected) return proc.exit(1);

    updateConfig({ currentOrgId: selected.id });
    clack.log.success(`Switched to ${bold(selected.name)}`);
  });
