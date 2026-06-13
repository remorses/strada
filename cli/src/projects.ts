// Project management CLI commands. Requires login first.
//
// Project slug→id mappings are cached in ~/.strada/config.json. On first use
// or when a slug isn't found in the cache, the CLI fetches all projects from
// the API and updates the cache. This avoids an API call on every command.

import { goke } from "goke";
import dedent from "string-dedent";
import { bold, cyan, dim } from "./colors.ts";
import { getResolvedConfig, loadConfig, updateConfig } from "./config.ts";
import type { CachedProject } from "./config.ts";
import { getApiClient } from "./api-client.ts";
import { resolveCurrentOrg } from "./orgs.ts";

export { resolveCurrentOrg } from "./orgs.ts";

export const projectsCli = goke();

// ── Shared helpers ────────────────────────────────────────────────
// Each helper calls getApiClient() internally. No passing safeFetch around.

export const ensureDefaultOrg = resolveCurrentOrg;

// ── Project cache ─────────────────────────────────────────────────
// Cached in ~/.strada/config.json keyed by org ID. Refreshed on cache miss.

function getOrgProjects(orgId: string): CachedProject[] {
  const config = loadConfig();
  return config.projectCacheByOrg?.[orgId] ?? [];
}

function setOrgProjects(orgId: string, projects: CachedProject[]) {
  const config = loadConfig();
  const projectCacheByOrg = { ...config.projectCacheByOrg, [orgId]: projects };
  updateConfig({ projectCacheByOrg });
}

async function fetchAndCacheProjects(orgId: string): Promise<CachedProject[]> {
  const { safeFetch } = getApiClient();
  const res = await safeFetch("/api/v0/orgs/:orgId/projects", { params: { orgId } });
  if (res instanceof Error) throw res;
  const projects: CachedProject[] = res.projects.map((p) => ({
    id: p.id,
    slug: p.slug,
  }));
  setOrgProjects(orgId, projects);
  return projects;
}

/** Resolve a project slug to its ID. Uses cache first, fetches on miss. */
export async function resolveProjectId(orgId: string, slug: string): Promise<{ id: string; slug: string }> {
  let projects = getOrgProjects(orgId);

  const cached = projects.find((p) => p.slug === slug);
  if (cached) return cached;

  // Cache miss, refetch
  projects = await fetchAndCacheProjects(orgId);
  const found = projects.find((p) => p.slug === slug);
  if (found) return found;
  throw new Error(`Project "${slug}" not found. Run \`strada projects list\` to see available projects.`);
}

export async function resolveProject(options: { project?: string; org?: string } = {}) {
  const org = await ensureDefaultOrg({ org: options.org });
  const scoped = getResolvedConfig();
  if (!options.project && scoped.orgId === org.id && scoped.projectId && scoped.projectSlug) {
    return { org, project: { id: scoped.projectId, slug: scoped.projectSlug } };
  }

  const projectRef = options.project || (scoped.orgId === org.id ? scoped.projectSlug : undefined);
  if (!projectRef) {
    throw new Error("No project configured for this folder. Run `strada setup` or pass `--project <slug>`.");
  }
  return { org, project: await resolveProjectId(org.id, projectRef) };
}

export async function resolveProjects(options: { project?: string[]; org?: string } = {}) {
  const org = await ensureDefaultOrg({ org: options.org });
  const scoped = getResolvedConfig();
  const slugs = options.project && options.project.length > 0
    ? options.project
    : scoped.orgId === org.id && scoped.projectSlug
      ? [scoped.projectSlug]
      : undefined;
  if (!slugs) {
    throw new Error("No project configured for this folder. Run `strada setup` or pass `--project <slug>`.");
  }
  return { org, slugs, projects: await Promise.all(slugs.map((slug) => resolveProjectId(org.id, slug))) };
}

// ── Project commands ──────────────────────────────────────────────

projectsCli
  .command(
    "projects list",
    dedent`
      List all projects in the current organization.

      Shows project slugs and IDs. Use the slug with -p in other commands.
      Slugs often include an environment suffix (e.g. 'my-app-prod').
      This also refreshes the local project cache.
    `,
  )
  .option("--org [name-or-id]", "Organization override (defaults to folder setup)")
  .action(async (options, { console: output }) => {
    const org = await ensureDefaultOrg({ org: options.org || undefined });
    // Always fetch fresh + update cache when user explicitly lists projects
    const projects = await fetchAndCacheProjects(org.id);

    if (projects.length === 0) {
      output.log("No projects yet. Create one with `strada projects create <slug>`");
      return;
    }

    output.log(bold(`Projects in ${org.name}:`));
    output.log("");
    for (const p of projects) {
      output.log(`  ${cyan(p.slug)} ${dim(`(${p.id})`)}`);
    }
  });

projectsCli
  .command(
    "projects create <slug>",
    dedent`
      Create a new project and generate its first org-wide ingest token.

      The generated project ID becomes the ingest hostname: \`{projectId}-ingest.strada.sh\`.
      The token printed at creation is shown only once. Save it as \`STRADA_TOKEN\`
      for server-side SDKs. Browser SDKs do not need a token.
    `,
  )
  .example('strada projects create my-app')
  .example('strada projects create my-app-prod')
  .option("--org [name-or-id]", "Organization override (defaults to folder setup)")
  .action(async (slug, options, { console: output }) => {
    const { safeFetch } = getApiClient();
    const org = await ensureDefaultOrg({ org: options.org || undefined });
    const res = await safeFetch("/api/v0/orgs/:orgId/projects", {
      method: "POST",
      params: { orgId: org.id },
      body: { slug },
    });
    if (res instanceof Error) throw res;

    // Update cache with the new project
    const projects = getOrgProjects(org.id);
    setOrgProjects(org.id, [...projects, { id: res.id, slug: res.slug }]);

    output.log(bold("Project created!"));
    output.log("");
    output.log(`  ID:              ${cyan(res.id)}`);
    output.log(`  Slug:            ${res.slug}`);
    output.log(`  Ingest endpoint: ${res.ingestEndpoint.toLowerCase()}`);
    output.log(`  Token:           ${cyan(res.token)}`);
    output.log("");
    output.log(bold("About the token:"));
    output.log(`  This is an org-wide ingest token. Pass it as ${cyan("STRADA_TOKEN")} in your server-side SDK.`);
    output.log(`  Without a token, ingest requests are treated as anonymous browser traffic and`);
    output.log(`  rate limited by Cloudflare. Server-side SDKs should always include a token to`);
    output.log(`  avoid hitting rate limits.`);
    output.log("");
    output.log(`  ${bold("Do not use this token in browser SDKs.")} Browser ingest is designed to work`);
    output.log(`  without a token. Embedding it in client-side code would expose it publicly.`);
    output.log("");
    output.log(dim("The token is shown only once. If lost, create a new one with `strada tokens create --scope ingest <name>`."));
    output.log(dim("Manage tokens with `strada tokens list` and `strada tokens create <name>`."));
  });

projectsCli
  .command(
    "projects delete <id>",
    dedent`
      Delete a project by its ID.

      This removes the project from D1. Data already ingested into
      Tinybird/ClickHouse is not deleted. Get the project ID from
      \`strada projects list\`.
    `,
  )
  .action(async (id, _options, { console: output }) => {
    const { safeFetch } = getApiClient();
    const res = await safeFetch("/api/v0/projects/:id", {
      method: "DELETE",
      params: { id },
    });
    if (res instanceof Error) throw res;
    // Remove from cache. We don't know the orgId here, so scan all orgs.
    const config = loadConfig();
    if (config.projectCacheByOrg) {
      const projectCacheByOrg = { ...config.projectCacheByOrg };
      for (const orgId of Object.keys(projectCacheByOrg)) {
        projectCacheByOrg[orgId] = projectCacheByOrg[orgId]!.filter((p) => p.id !== id);
      }
      updateConfig({ projectCacheByOrg });
    }
    output.log(`Project ${id} deleted.`);
  });

// Legacy query command removed. Use the top-level `strada query` from query.ts
// which renders tables, supports FORMAT clauses, and has better help output.
