// Project management CLI commands. Requires login first.

import * as clack from "@clack/prompts";
import { goke } from "goke";
import type { GokeExecutionContext } from "goke";
import picocolors from "picocolors";
import { requireAuth } from "./config.ts";
import { createApiClient } from "./api-client.ts";

export const projectsCli = goke();

projectsCli
  .command("projects list", "List all projects in your organization")
  .action((_options, ctx) => listProjectsAction(ctx));

projectsCli
  .command("projects create <slug>", "Create a new project")
  .action((options, ctx) => createProjectAction(options, ctx));

projectsCli
  .command("projects delete <id>", "Delete a project")
  .action((options, ctx) => deleteProjectAction(options, ctx));

projectsCli
  .command("query <sql>", "Run a SQL query against your project's database")
  .option("-p, --project [id]", "Project ID (uses first project if not specified)")
  .action((options, ctx) => queryAction(options, ctx));

async function getDefaultOrg(safeFetch: ReturnType<typeof createApiClient>["safeFetch"], authHeaders: Record<string, string>) {
  const res = await safeFetch("/api/orgs", { headers: { ...authHeaders } });
  if (res instanceof Error) throw res;
  if (res.orgs.length === 0) {
    throw new Error("No organizations found. Create one first.");
  }
  return res.orgs[0]!;
}

async function listProjectsAction({ console: output }: GokeExecutionContext) {
  const auth = requireAuth();
  const { safeFetch, authHeaders } = createApiClient(auth.baseUrl, auth.sessionToken);
  const org = await getDefaultOrg(safeFetch, authHeaders);
  const res = await safeFetch(`/api/orgs/${org.id}/projects`, { headers: { ...authHeaders } });
  if (res instanceof Error) throw res;

  if (res.projects.length === 0) {
    output.log("No projects yet. Create one with `strada projects create <slug>`");
    return;
  }

  output.log(picocolors.bold(`Projects in ${org.name}:`));
  output.log("");
  for (const p of res.projects) {
    output.log(`  ${picocolors.cyan(p.slug)} ${picocolors.dim(`(${p.id})`)}`);
    output.log(`    Ingest: ${p.ingestEndpoint}`);
  }
}

async function createProjectAction(
  options: { args: string[] },
  { console: output, process: proc }: GokeExecutionContext,
) {
  const slug = options.args[0];
  if (!slug) {
    output.log("Usage: strada projects create <slug>");
    return proc.exit(1);
  }

  const auth = requireAuth();
  const { safeFetch, authHeaders } = createApiClient(auth.baseUrl, auth.sessionToken);
  const org = await getDefaultOrg(safeFetch, authHeaders);
  const res = await safeFetch(`/api/orgs/${org.id}/projects`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  if (res instanceof Error) throw res;

  output.log(picocolors.bold("Project created!"));
  output.log("");
  output.log(`  ID:     ${picocolors.cyan(res.id)}`);
  output.log(`  Slug:   ${res.slug}`);
  output.log(`  Ingest: ${res.ingestEndpoint}`);
  output.log("");
  output.log(picocolors.dim("Configure your SDK with this endpoint to start sending data."));
}

async function deleteProjectAction(
  options: { args: string[] },
  { console: output, process: proc }: GokeExecutionContext,
) {
  const id = options.args[0];
  if (!id) {
    output.log("Usage: strada projects delete <id>");
    return proc.exit(1);
  }

  const auth = requireAuth();
  const { safeFetch, authHeaders } = createApiClient(auth.baseUrl, auth.sessionToken);
  const res = await safeFetch(`/api/projects/${id}`, {
    method: "DELETE",
    headers: { ...authHeaders },
  });
  if (res instanceof Error) throw res;
  output.log(`Project ${id} deleted.`);
}

async function queryAction(
  options: { args: string[]; project?: string },
  { console: output, process: proc }: GokeExecutionContext,
) {
  const sql = options.args[0];
  if (!sql) {
    output.log("Usage: strada query <sql>");
    return proc.exit(1);
  }

  const auth = requireAuth();
  const { safeFetch, authHeaders } = createApiClient(auth.baseUrl, auth.sessionToken);
  const org = await getDefaultOrg(safeFetch, authHeaders);

  let projectId = options.project;
  if (!projectId) {
    const res = await safeFetch(`/api/orgs/${org.id}/projects`, { headers: { ...authHeaders } });
    if (res instanceof Error) throw res;
    if (res.projects.length === 0) {
      clack.log.error("No projects found. Create one first with `strada projects create <slug>`");
      return proc.exit(1);
    }
    projectId = res.projects[0]!.id;
  }

  const res = await safeFetch(`/api/projects/${projectId}/query`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  if (res instanceof Error) throw res;
  output.log(JSON.stringify(res, null, 2));
}
