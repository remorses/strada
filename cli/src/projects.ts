// Project management CLI commands. Requires login first.
//
// Project slug→id mappings are cached in ~/.strada/config.json. On first use
// or when a slug isn't found in the cache, the CLI fetches all projects from
// the API and updates the cache. This avoids an API call on every command.

import { goke } from "goke";
import * as clack from "@clack/prompts";
import dedent from "string-dedent";
import { z } from "zod";
import { bold, cyan, dim, green } from "./colors.ts";
import { getResolvedConfig, loadConfig, updateConfig } from "./config.ts";
import type { CachedProject } from "./config.ts";
import { getApiClient } from "./api-client.ts";
import { waitForTinybirdMigration } from "./database.ts";
import { resolveCurrentOrg } from "./orgs.ts";
import { printTable } from "./table.ts";
import { RETENTION_MAX_DAYS, RETENTION_MIN_DAYS } from "./tinybird-retention.ts";

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

const retentionDaysOption = z.union([
  z.literal("keep"),
  z.coerce.number().int().min(RETENTION_MIN_DAYS).max(RETENTION_MAX_DAYS),
])

function parseRetentionDays(value: "keep" | number | undefined): number | null | undefined {
  if (value == null) return undefined
  if (value === "keep") return null
  return value
}

type RetentionOptions = {
  tracesDays?: "keep" | number
  logsDays?: "keep" | number
  errorsDays?: "keep" | number
  metricsDays?: "keep" | number
  allDays?: "keep" | number
}

export function buildRetentionUpdate(options: RetentionOptions): Error | undefined | {
  tracesDays?: number | null
  logsDays?: number | null
  errorsDays?: number | null
  metricsDays?: number | null
} {
  const individual = {
    tracesDays: parseRetentionDays(options.tracesDays),
    logsDays: parseRetentionDays(options.logsDays),
    errorsDays: parseRetentionDays(options.errorsDays),
    metricsDays: parseRetentionDays(options.metricsDays),
  }
  const hasIndividual = Object.values(individual).some((value) => value !== undefined)
  const allDays = parseRetentionDays(options.allDays)
  if (allDays !== undefined && hasIndividual) {
    return new Error("Do not combine `--all-days` with signal-specific retention flags. Use either `--all-days 30` or individual flags.")
  }
  if (allDays !== undefined) {
    return {
      tracesDays: allDays,
      logsDays: allDays,
      errorsDays: allDays,
      metricsDays: allDays,
    }
  }
  if (!hasIndividual) return undefined
  return Object.fromEntries(
    Object.entries(individual).filter(([, value]) => value !== undefined),
  )
}

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
  .example('strada projects create staging --all-days 7')
  .option("--org [name-or-id]", "Organization override (defaults to folder setup)")
  .option("--traces-days <days>", retentionDaysOption.describe("Trace retention in days, or keep"))
  .option("--logs-days <days>", retentionDaysOption.describe("Log and custom-event retention in days, or keep"))
  .option("--errors-days <days>", retentionDaysOption.describe("Error retention in days, or keep"))
  .option("--metrics-days <days>", retentionDaysOption.describe("Metrics retention in days, or keep"))
  .option("--all-days <days>", retentionDaysOption.describe("Set all four signals to the same number of days, or keep"))
  .action(async (slug, options, { console: output, process: proc }) => {
    const retentionBody = buildRetentionUpdate(options)
    if (retentionBody instanceof Error) {
      output.error(retentionBody.message)
      return proc.exit(1)
    }

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

    if (!retentionBody) {
      output.log("");
      output.log(dim("Raw telemetry is kept. Set a TTL with `strada projects retention update`."));
      return
    }

    output.log("")
    const retention = await safeFetch("/api/v0/projects/:id/retention", {
      method: "PUT",
      params: { id: res.id },
      body: retentionBody,
    })
    if (retention instanceof Error) {
      output.error(`Project created, but custom retention was not applied: ${retention.message}`)
      output.error("The ingest token above remains valid. Run `strada projects retention update` to retry.")
      return proc.exit(1)
    }
    if (retention.deployment === "failed") {
      output.error(`Custom retention was saved but not applied: ${retention.error}`)
      output.error("The ingest token above remains valid. Run `strada database upgrade` to retry.")
      return proc.exit(1)
    }
    if (retention.deployment === "in_progress") {
      const spinner = clack.spinner()
      spinner.start("Waiting for Tinybird to apply TTL...")
      const migrated = await waitForTinybirdMigration({ orgId: org.id, spinner })
      if (migrated instanceof Error) {
        spinner.stop("Custom retention is still pending")
        output.error(migrated.message)
        return proc.exit(1)
      }
      spinner.stop("Tinybird applied TTL")
    }
    output.log(green("Custom retention was applied."));
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
    if (res.retention?.deployment === "in_progress") {
      output.log(dim("Tinybird is still removing the deleted project's TTL rule. Re-run `strada database upgrade` later if needed."));
    }
    if (res.retention?.deployment === "failed") {
      output.error(`Tinybird retention reconciliation failed: ${res.retention.error}`);
      output.error("The project was deleted. Run `strada database upgrade` to retry the TTL change.");
    }
  });

function formatRetentionDays(days: number | null): string {
  return days == null ? "keep" : String(days)
}

function printRetention(output: { log: (msg: string) => void }, retention: {
  tracesDays: number | null
  logsDays: number | null
  errorsDays: number | null
  metricsDays: number | null
}) {
  printTable(output, {
    columns: [
      { key: "signal", label: "SIGNAL" },
      { key: "days", label: "DAYS", color: cyan },
    ],
    rows: [
      { signal: "traces", days: formatRetentionDays(retention.tracesDays) },
      { signal: "logs", days: formatRetentionDays(retention.logsDays) },
      { signal: "errors", days: formatRetentionDays(retention.errorsDays) },
      { signal: "metrics", days: formatRetentionDays(retention.metricsDays) },
    ],
  })
}

projectsCli
  .command(
    "projects retention",
    dedent`
      Show raw telemetry retention for a project.

      Raw traces, logs, errors, and metrics are kept unless a project sets a
      custom TTL. \`--logs-days\` also controls custom product events stored in
      \`otel_logs\`. Aggregated browser analytics and health-check results stay
      at a fixed 90 days. Issue state and identified users are kept.

      This shows the configured policy. Tinybird may still be applying it.
      Per-project custom values require a Tinybird backend. Self-hosted
      ClickHouse keeps all raw telemetry unless you add table TTL yourself.
    `,
  )
  .option("-p, --project [slug]", "Project slug override (defaults to folder setup)")
  .option("--org [name-or-id]", "Organization override (defaults to folder setup)")
  .example("strada projects retention")
  .example("strada projects retention -p api")
  .action(async (options, { console: output }) => {
    const { project } = await resolveProject({ project: options.project, org: options.org })
    const { safeFetch } = getApiClient()
    const res = await safeFetch("/api/v0/projects/:id/retention", {
      params: { id: project.id },
    })
    if (res instanceof Error) throw res
    output.log(bold(`Configured retention for ${project.slug}:`))
    output.log("")
    printRetention(output, res)
  })

projectsCli
  .command(
    "projects retention update",
    dedent`
      Update raw telemetry retention for a project.

      Raw telemetry is kept by default. Setting a day count can delete existing
      Tinybird rows after promotion. Pass \`keep\` to remove a custom TTL.
      TTL deletion is asynchronous and can take a few hours. Custom values
      require Tinybird. Analytics stay at 90 days.

      Pass either \`--all-days\` or individual signal flags. Do not mix them.
      If Tinybird is still applying the change, run \`strada database upgrade\` later.
    `,
  )
  .option("-p, --project [slug]", "Project slug override (defaults to folder setup)")
  .option("--org [name-or-id]", "Organization override (defaults to folder setup)")
  .option("--traces-days <days>", retentionDaysOption.describe("Trace retention in days, or keep"))
  .option("--logs-days <days>", retentionDaysOption.describe("Log and custom-event retention in days, or keep"))
  .option("--errors-days <days>", retentionDaysOption.describe("Error retention in days, or keep"))
  .option("--metrics-days <days>", retentionDaysOption.describe("Metrics retention in days, or keep"))
  .option("--all-days <days>", retentionDaysOption.describe("Set all four signals to the same number of days, or keep"))
  .example("strada projects retention update --traces-days 7")
  .example("strada projects retention update -p staging --all-days 14")
  .example("strada projects retention update --traces-days keep")
  .action(async (options, { console: output, process: proc }) => {
    const body = buildRetentionUpdate(options)
    if (body instanceof Error) {
      output.error(body.message)
      return proc.exit(1)
    }
    if (!body) {
      output.log(dim("Nothing to update. Pass --all-days or a signal flag such as --traces-days."))
      return
    }

    const { org, project } = await resolveProject({ project: options.project, org: options.org })
    const { safeFetch } = getApiClient()
    const current = await safeFetch("/api/v0/projects/:id/retention", {
      params: { id: project.id },
    })
    if (current instanceof Error) throw current

    const res = await safeFetch("/api/v0/projects/:id/retention", {
      method: "PUT",
      params: { id: project.id },
      body,
    })
    if (res instanceof Error) throw res

    output.log(bold(`Updated retention for ${project.slug}`))
    output.log("")
    output.log(dim("Previous:"))
    printRetention(output, current)
    output.log("")
    output.log(dim("New:"))
    printRetention(output, res.retention)

    if (res.deployment === "failed") {
      output.error(`Retention settings were saved but Tinybird rejected the deployment: ${res.error}`)
      output.error("Run `strada database upgrade` after fixing the Tinybird deployment error.")
      return proc.exit(1)
    }
    if (res.deployment === "in_progress") {
      const spinner = clack.spinner()
      spinner.start("Waiting for Tinybird to apply TTL...")
      const migrated = await waitForTinybirdMigration({ orgId: org.id, spinner })
      if (migrated instanceof Error) {
        spinner.stop("Tinybird is still applying TTL")
        output.log(migrated.message)
        return proc.exit(1)
      }
      spinner.stop("Tinybird applied TTL")
    }

    output.log("")
    output.log(green("Retention settings were saved."))
  })

// Legacy query command removed. Use the top-level `strada query` from query.ts
// which renders tables, supports FORMAT clauses, and has better help output.
