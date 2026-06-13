// Destination management CLI commands. Destinations are org-scoped
// delivery endpoints (email, webhook, slack) that receive both error
// alerts and health check alerts. They auto-link to all rules in the org.

import { goke } from "goke";
import dedent from "string-dedent";
import { bold, cyan, dim, green } from "./colors.ts";
import { getApiClient } from "./api-client.ts";
import { ensureDefaultOrg } from "./projects.ts";
import { printTable } from "./table.ts";

export const destinationsCli = goke();

// ── destinations list ────────────────────────────────────────────

destinationsCli
  .command(
    "destinations list",
    dedent`
      List all notification destinations for the current org.

      Destinations receive both error alerts and health check alerts.
      They are auto-linked to all alert rules in the org.
    `,
  )
  .action(async (_options, { console: output }) => {
    const org = await ensureDefaultOrg();
    const { safeFetch } = getApiClient();

    const res = await safeFetch("/api/v0/orgs/:orgId/destinations", {
      method: "GET",
      params: { orgId: org.id },
    });
    if (res instanceof Error) throw res;

    const destinations = (res as { destinations: any[] }).destinations;

    if (destinations.length === 0) {
      output.log(dim("No destinations configured."));
      output.log("");
      output.log(`Add one with: ${cyan("strada alerts create --name 'My alerts' --channel email --to you@example.com")}`);
      return;
    }

    output.log("");
    output.log(bold(`Destinations for ${cyan(org.name)}`));
    output.log("");

    printTable(output, {
      columns: [
        { key: "channel", label: "CHANNEL", color: cyan },
        { key: "destination", label: "DESTINATION" },
        { key: "id", label: "ID", color: dim },
      ],
      rows: destinations,
    });

    output.log("");
  });

// ── destinations remove ──────────────────────────────────────────

destinationsCli
  .command(
    "destinations remove <id>",
    dedent`
      Remove a notification destination.

      Unlinks the destination from all alert rules and deletes it.
      Get the destination ID from \`strada destinations list\` or \`strada alerts list\`.
    `,
  )
  .action(async (id, _options, { console: output }) => {
    const org = await ensureDefaultOrg();
    const { safeFetch } = getApiClient();

    const res = await safeFetch("/api/v0/orgs/:orgId/destinations/:destinationId", {
      method: "DELETE",
      params: { orgId: org.id, destinationId: id },
    });
    if (res instanceof Error) throw res;

    output.log(green(`Destination ${cyan(id)} removed`));
  });


