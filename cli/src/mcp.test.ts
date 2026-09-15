import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { addCliToolsToMcp } from "@goke/mcp";
import { cli, isMcpCommand } from "./cli.ts";
import { buildRetentionUpdate } from "./projects.ts";

async function listTools() {
  const server = new Server({ name: "strada", version: "0.0.0" }, { capabilities: {} });
  addCliToolsToMcp({ cli, server, commandFilter: isMcpCommand });

  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

describe("mcp command", () => {
  test("registers strada mcp as a stdio MCP server", () => {
    const command = cli.commands.find((entry) => entry.name === "mcp");

    expect(command).toBeTruthy();
    expect(command?.commandAction).toBeTypeOf("function");
    expect(command?.description).toContain("MCP");
  });

  test("exposes CLI commands as MCP tools except browser and local-session flows", async () => {
    const tools = await listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toMatchInlineSnapshot(`
      [
        "whoami",
        "orgs_list",
        "setup",
        "projects_list",
        "projects_create",
        "projects_delete",
        "projects_retention",
        "issues_list",
        "issues_view",
        "issues_resolve",
        "issues_mute",
        "issues_unresolve",
        "issues_assign",
        "analytics_pages",
        "analytics_browsers",
        "analytics_devices",
        "analytics_countries",
        "analytics_referrers",
        "analytics_languages",
        "analytics_kpis",
        "analytics_overview",
        "analytics_timeseries",
        "analytics_visitors",
        "analytics_events",
        "analytics_realtime",
        "query",
        "alerts_create",
        "alerts_list",
        "alerts_update",
        "alerts_delete",
        "alerts_test",
        "checks_create",
        "checks_list",
        "checks_delete",
        "checks_enable",
        "checks_disable",
        "destinations_list",
        "destinations_remove",
        "logs",
        "services_list",
        "traces_list",
        "traces_span",
        "traces_view",
        "tokens_create",
        "tokens_list",
        "tokens_delete",
      ]
    `);
    expect(names).not.toContain("login");
    expect(names).not.toContain("logout");
    expect(names).not.toContain("database_create");
    expect(names).not.toContain("database_upgrade");
    expect(names).not.toContain("mcp");
  });

  test("validates retention update option combinations before API calls", () => {
    expect(buildRetentionUpdate({ allDays: 30, tracesDays: 7 })).toEqual(
      new Error("Do not combine `--all-days` with signal-specific retention flags. Use either `--all-days 30` or individual flags."),
    );
    expect(buildRetentionUpdate({ logsDays: 14 })).toEqual({ logsDays: 14 });
  });

  test("optional CLI flags are optional in MCP schemas", async () => {
    const tools = await listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    expect(byName.logs.inputSchema.required).toBeUndefined();
    expect(byName.issues_list.inputSchema.required).toBeUndefined();
    expect(byName.alerts_create.inputSchema.required).toEqual(["name"]);
    expect(byName.checks_create.inputSchema.required).toEqual(["url", "name"]);
    expect(byName.traces_view.inputSchema.required).toEqual(["traceId"]);
  });
});
