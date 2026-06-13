// Org and setup CLI commands. Folder scopes map a cwd to its default org and project.

import * as clack from "@clack/prompts";
import { goke } from "goke";
import dedent from "string-dedent";
import { z } from "zod";
import { bold, cyan, dim, green } from "./colors.ts";
import { getResolvedConfig, setScope, updateConfig, loadConfig } from "./config.ts";
import type { CachedProject } from "./config.ts";
import { getApiClient } from "./api-client.ts";

export const orgsCli = goke();

export interface OrgInfo {
  id: string;
  name: string;
  role: string;
}

export async function fetchOrgs(): Promise<OrgInfo[]> {
  const { safeFetch } = getApiClient();
  const res = await safeFetch("/api/v0/orgs");
  if (res instanceof Error) throw res;
  return res.orgs;
}

export async function fetchProjects(orgId: string): Promise<CachedProject[]> {
  const { safeFetch } = getApiClient();
  const res = await safeFetch("/api/v0/orgs/:orgId/projects", { params: { orgId } });
  if (res instanceof Error) throw res;
  const projects = res.projects.map((project) => ({ id: project.id, slug: project.slug }));
  const config = loadConfig();
  updateConfig({ projectCacheByOrg: { ...config.projectCacheByOrg, [orgId]: projects } });
  return projects;
}

function findByNameOrId<T extends { id: string; name?: string; slug?: string }>(items: T[], value: string): T | undefined {
  return items.find((item) =>
    item.id === value || item.name?.toLowerCase() === value.toLowerCase() || item.slug === value
  );
}

export async function resolveCurrentOrg(options: { org?: string; cwd?: string } = {}): Promise<OrgInfo> {
  const orgs = await fetchOrgs();
  const scoped = getResolvedConfig(options.cwd);
  const orgRef = options.org || scoped.orgId;

  if (orgRef) {
    const match = findByNameOrId(orgs, orgRef);
    if (match) return match;
    throw new Error(`Organization "${orgRef}" not found. Run \`strada orgs list\` to see available orgs.`);
  }

  if (orgs.length === 1) return orgs[0]!;

  throw new Error("No organization configured for this folder. Run `strada setup` or pass `--org <name-or-id>`.");
}

orgsCli
  .command(
    "orgs list",
    dedent`
      List all organizations you belong to.

      Shows org name, role, and ID. A green dot marks the org configured for
      the current folder. If no org is configured, run \`strada setup\`.
    `,
  )
  .action(async (_options, { console: output, process: proc }) => {
    const orgs = await fetchOrgs();
    const current = getResolvedConfig(proc.cwd);

    if (orgs.length === 0) {
      output.log("No organizations found.");
      return;
    }

    output.log(bold("Organizations:"));
    output.log("");
    for (const org of orgs) {
      const isCurrent = org.id === current.orgId || (!current.orgId && orgs.length === 1);
      const marker = isCurrent ? green("● ") : "  ";
      output.log(`${marker}${cyan(org.name)} ${dim(`(${org.role})`)} ${dim(org.id)}`);
    }

    if (!current.orgId && orgs.length > 1) {
      output.log("");
      output.log(dim("No org configured for this folder. Run `strada setup`."));
    }
  });

orgsCli
  .command(
    "setup",
    dedent`
      Save the default organization and project for the current folder.

      Strada resolves config by walking up from the current directory and using
      the closest matching scope. Use this once per app folder so commands like
      \`strada logs\` and \`strada issues list\` do not need \`-p\`.
    `,
  )
  .option("--scope [path]", z.string().describe("Directory scope to configure (default: current directory)"))
  .option("--org [name-or-id]", z.string().describe("Organization name or ID"))
  .option("-p, --project [slug-or-id]", z.string().describe("Project slug or ID"))
  .action(async (options, { console: output, process: proc }) => {
    const cwd = options.scope || proc.cwd;
    const isTty = process.stdin.isTTY && process.stdout.isTTY;

    const orgs = await fetchOrgs();
    let org = options.org ? findByNameOrId(orgs, options.org) : undefined;
    if (options.org && !org) throw new Error(`Organization "${options.org}" not found.`);

    if (!org) {
      if (!isTty) throw new Error("--org is required in non-interactive mode.");
      const choice = await clack.select({
        message: "Select organization",
        options: orgs.map((item) => ({ value: item.id, label: item.name, hint: `${item.role} · ${item.id}` })),
      });
      if (clack.isCancel(choice)) return proc.exit(0);
      org = orgs.find((item) => item.id === choice);
    }
    if (!org) return proc.exit(1);

    const projects = await fetchProjects(org.id);
    let project = options.project ? findByNameOrId(projects, options.project) : undefined;
    if (options.project && !project) throw new Error(`Project "${options.project}" not found in ${org.name}.`);

    if (!project) {
      if (!isTty) throw new Error("--project is required in non-interactive mode.");
      const choice = await clack.select({
        message: "Select project",
        options: projects.map((item) => ({ value: item.id, label: item.slug, hint: item.id })),
      });
      if (clack.isCancel(choice)) return proc.exit(0);
      project = projects.find((item) => item.id === choice);
    }
    if (!project) return proc.exit(1);

    setScope(cwd, {
      orgId: org.id,
      orgName: org.name,
      projectId: project.id,
      projectSlug: project.slug,
    });

    output.log(green("✔") + ` Saved setup for ${bold(cwd)}`);
    output.log(`  org:     ${cyan(org.name)} ${dim(org.id)}`);
    output.log(`  project: ${cyan(project.slug)} ${dim(project.id)}`);
  });
