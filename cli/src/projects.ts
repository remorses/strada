// Project management CLI commands. Requires login first.
//
// Project slug→id mappings are cached in ~/.strada/config.json. On first use
// or when a slug isn't found in the cache, the CLI fetches all projects from
// the API and updates the cache. This avoids an API call on every command.

import { goke } from "goke";
import { bold, cyan, dim } from "./colors.ts";
import { loadConfig, updateConfig } from "./config.ts";
import type { CachedProject } from "./config.ts";
import { getApiClient } from "./api-client.ts";

export const projectsCli = goke();

// ── Shared helpers ────────────────────────────────────────────────
// Each helper calls getApiClient() internally. No passing safeFetch around.

export async function ensureDefaultOrg() {
  const { safeFetch } = getApiClient();
  const res = await safeFetch("/api/v0/orgs/ensure-default", { method: "POST" });
  if (res instanceof Error) throw res;
  return { id: res.id, name: res.name, role: "admin" as const };
}

// ── Project cache ─────────────────────────────────────────────────
// Cached in ~/.strada/config.json as an array of {id, slug} objects.
// Refreshed automatically when a slug lookup misses.

async function fetchAndCacheProjects(orgId: string): Promise<CachedProject[]> {
  const { safeFetch } = getApiClient();
  const res = await safeFetch("/api/v0/orgs/:orgId/projects", { params: { orgId } });
  if (res instanceof Error) throw res;
  const projects: CachedProject[] = res.projects.map((p) => ({
    id: p.id,
    slug: p.slug,
  }));
  updateConfig({ projects });
  return projects;
}

/** Resolve a project slug to its ID. Uses cache first, fetches on miss. */
export async function resolveProjectId(orgId: string, slug: string): Promise<{ id: string; slug: string }> {
  let projects = loadConfig().projects ?? [];

  const cached = projects.find((p) => p.slug === slug);
  if (cached) return cached;

  // Cache miss, refetch
  projects = await fetchAndCacheProjects(orgId);
  const found = projects.find((p) => p.slug === slug);
  if (found) return found;
  throw new Error(`Project "${slug}" not found. Run \`strada projects list\` to see available projects.`);
}

// ── Project commands ──────────────────────────────────────────────

projectsCli
  .command("projects list", "List all projects in your organization")
  .action(async (_options, { console: output }) => {
    const org = await ensureDefaultOrg();
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
  .command("projects create <slug>", "Create a new project")
  .action(async (slug, _options, { console: output }) => {
    const { safeFetch } = getApiClient();
    const org = await ensureDefaultOrg();
    const res = await safeFetch("/api/v0/orgs/:orgId/projects", {
      method: "POST",
      params: { orgId: org.id },
      body: { slug },
    });
    if (res instanceof Error) throw res;

    // Update cache with the new project
    const projects = loadConfig().projects ?? [];
    updateConfig({ projects: [...projects, { id: res.id, slug: res.slug }] });

    output.log(bold("Project created!"));
    output.log("");
    output.log(`  ID:     ${cyan(res.id)}`);
    output.log(`  Slug:   ${res.slug}`);
    output.log(`  Ingest: ${res.ingestEndpoint.toLowerCase()}`);
    output.log("");
    output.log(dim("Configure your SDK with this endpoint to start sending data."));
  });

projectsCli
  .command("projects delete <id>", "Delete a project")
  .action(async (id, _options, { console: output }) => {
    const { safeFetch } = getApiClient();
    const res = await safeFetch("/api/v0/projects/:id", {
      method: "DELETE",
      params: { id },
    });
    if (res instanceof Error) throw res;
    // Remove from cache
    const projects = (loadConfig().projects ?? []).filter((p) => p.id !== id);
    updateConfig({ projects });
    output.log(`Project ${id} deleted.`);
  });

projectsCli
  .command("query <sql>", "Run a SQL query against your project's database")
  .option("-p, --project <slug>", "Project slug (run `strada projects list` to see slugs)")
  .action(async (sql, options, { console: output, process: proc }) => {
    if (!options.project) {
      output.log("Missing required option: --project <slug>");
      output.log(dim("Run `strada projects list` to see available project slugs."));
      return proc.exit(1);
    }
    const { safeFetch } = getApiClient();
    const org = await ensureDefaultOrg();
    const project = await resolveProjectId(org.id, options.project);

    const res = await safeFetch("/api/v0/projects/:projectId/query", {
      method: "POST",
      params: { projectId: project.id },
      body: { sql },
    });
    if (res instanceof Error) throw res;
    output.log(JSON.stringify(res, null, 2));
  });
