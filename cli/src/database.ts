// Database management commands.
// `strada database create` bootstraps a Tinybird workspace and saves its config.
// `strada database upgrade` updates the saved workspace to the latest schema.

import * as clack from "@clack/prompts";
import { goke } from "goke";
import type { GokeExecutionContext } from "goke";
import { bold, cyan } from "./colors.ts";
import dedent from "string-dedent";
import { browserLogin } from "./tinybird-browser-login.ts";
import { loadTinybirdResources } from "./tinybird-resources.ts";
import { deployTinybirdResources, getDeploymentManagedReadToken, TinybirdClient } from "./tinybird.ts";
import { requireAuth } from "./config.ts";
import { getApiClient } from "./api-client.ts";
import { resolveCurrentOrg } from "./orgs.ts";

export interface DatabaseCreateOptions {
  token?: string;
  baseUrl?: string;
  force?: boolean;
}

function getTinybirdEnvAuth() {
  const token = process.env.TINYBIRD_TOKEN || process.env.TB_TOKEN
  const baseUrl = process.env.TINYBIRD_BASE_URL || process.env.TINYBIRD_HOST || process.env.TB_HOST
  if (!token) return null
  return {
    token,
    baseUrl: baseUrl || 'https://api.tinybird.co',
  }
}

function createTokenNameSuffix() {
  return Date.now().toString(36)
}

export const databaseCli = goke();

databaseCli
  .command(
    "database create",
    dedent`
      Create a Strada database on your own Tinybird workspace.

      Requires \`strada login\` first. Authenticates with Tinybird via browser
      OAuth, deploys OTel datasources and materialized views, then saves the
      tokens to your Strada database.

      For non-interactive Tinybird auth, pass --token and --base-url directly.
    `,
  )
  .option("-t, --token [token]", "Tinybird workspace admin token (skips browser login)")
  .option("-u, --base-url [url]", "Tinybird API base URL (e.g. https://api.us-east.aws.tinybird.co)")
  .option("-f, --force", "Overwrite existing database config without confirmation")
  .example("# Interactive setup (opens browser)")
  .example("strada database create")
  .example("# Non-interactive with existing token")
  .example("strada database create --token p.eyXXX --base-url https://api.tinybird.co")
  .action((options, context) => databaseCreateAction(options, context));

databaseCli
  .command(
    "database upgrade",
    dedent`
      Upgrade the Tinybird schema to the latest version.

      Requires \`strada login\` first. Uses the Tinybird workspace already saved
      in Strada for the current org. Applies any new datasource or materialized
      view changes from the latest CLI version.
    `,
  )
  .example("strada database upgrade")
  .action(async (_options, context) => databaseUpgradeAction(context));

export async function databaseCreateAction(
  options: DatabaseCreateOptions,
  { console: output, process: proc }: GokeExecutionContext,
) {
  clack.intro(bold("Strada — Database setup"));

  // Require Strada login first
  let stradaAuth: { sessionToken: string; baseUrl: string };
  try {
    stradaAuth = requireAuth();
  } catch (e) {
    clack.log.error((e as Error).message);
    return proc.exit(1);
  }

  // Create a default personal org on first use so `strada login` -> `strada database create`
  // works end to end without a manual org bootstrap step.
  const org = await resolveCurrentOrg().catch((error) => error as Error);
  if (org instanceof Error) {
    clack.log.error(org.message);
    return proc.exit(1);
  }
  clack.log.info(`Using organization: ${cyan(org.name)}`);

  // Check if this org already has a configured database. If so, require
  // explicit confirmation (interactive) or --force (non-interactive) to
  // prevent accidental overwrites of Tinybird tokens.
  if (!options.force) {
    const { safeFetch: checkFetch } = getApiClient();
    const existingDb = await checkFetch("/api/v0/orgs/:orgId/database", {
      params: { orgId: org.id },
    });
    if (!(existingDb instanceof Error) && (existingDb.hasAdminToken || existingDb.hasReadToken)) {
      const endpoint = existingDb.tinybirdEndpoint || existingDb.clickhouseUrl || "unknown";
      if (!process.stdin.isTTY) {
        clack.log.error(
          `This org already has a configured ${existingDb.backend} database (${endpoint}).\n` +
          `  Pass --force to overwrite it.`,
        );
        return proc.exit(1);
      }
      const overwrite = await clack.confirm({
        message: `This org already has a configured ${existingDb.backend} database (${endpoint}). Overwrite it?`,
      });
      if (clack.isCancel(overwrite) || !overwrite) {
        clack.outro("Cancelled. Existing database config is unchanged.");
        return proc.exit(0);
      }
    }
  }

  // Authenticate with Tinybird
  const auth = await (async () => {
    if (options.token && options.baseUrl) {
      clack.log.info(`Using provided token for ${options.baseUrl}`);
      return { token: options.token, baseUrl: options.baseUrl };
    }

    if (options.token && !options.baseUrl) {
      return new Error("--base-url is required when using --token");
    }

    const envAuth = getTinybirdEnvAuth()
    if (envAuth) {
      clack.log.info(`Using Tinybird token from environment for ${envAuth.baseUrl}`)
      return envAuth
    }

    if (!process.stdin.isTTY) {
      return new Error("Tinybird login needs browser interaction. Run `strada database create` in a background terminal session with tuistory or tmux, or re-run with --token and --base-url (or TINYBIRD_TOKEN and TINYBIRD_BASE_URL).")
    }

    clack.log.info("Opening browser to authenticate with Tinybird...");
    return browserLogin();
  })();
  if (auth instanceof Error) {
    clack.log.error(auth.message);
    return proc.exit(1);
  }

  const client = new TinybirdClient({ baseUrl: auth.baseUrl, token: auth.token });
  const workspace = await client.getWorkspace();
  if (workspace instanceof Error) {
    clack.log.error(workspace.message);
    return proc.exit(1);
  }

  clack.log.success(`Authenticated as ${cyan(workspace.user_email)} in workspace ${cyan(workspace.name)}`);

  clack.log.warn(
    `Strada will create OTel datasources in "${workspace.name}".\n` +
    `  Use a fresh, dedicated Tinybird workspace — do NOT point this at an existing workspace\n` +
    `  with unrelated data or different schemas. Deploying to the wrong workspace can corrupt\n` +
    `  or overwrite existing datasources.`,
  );

  if (process.stdin.isTTY) {
    const confirmed = await clack.confirm({
      message: `Deploy Strada OTel tables into workspace "${workspace.name}"?`,
    });
    if (clack.isCancel(confirmed) || !confirmed) {
      clack.outro("Cancelled. Create a new dedicated Tinybird workspace and re-run strada database create.");
      return proc.exit(0);
    }
  }

  const spinner = clack.spinner();
  spinner.start("Loading Tinybird resource files...");

  const resources = await (async () => loadTinybirdResources())().catch((cause) => new Error(String(cause instanceof Error ? cause.message : cause)));
  if (resources instanceof Error) {
    spinner.stop("Failed to load resources");
    clack.log.error(resources.message);
    return proc.exit(1);
  }

  spinner.message(`Found ${resources.datasources.length} datasources, ${resources.pipes.length} pipes`);
  spinner.message("Deploying to Tinybird...");

  const deployment = await deployTinybirdResources({ client, datasources: resources.datasources, pipes: resources.pipes });
  if (deployment instanceof Error) {
    spinner.stop("Deployment failed");
    clack.log.error(deployment.message);
    return proc.exit(1);
  }

  spinner.stop(deployment.result === "no_changes" ? "No schema changes to deploy" : "Deployed successfully");

  const tokenSpinner = clack.spinner();
  tokenSpinner.start("Creating tokens...");

  const tokenNameSuffix = createTokenNameSuffix()

  const [adminToken, readToken] = await Promise.all([
    client.createToken({ name: `strada-admin-${tokenNameSuffix}`, scope: "ADMIN" }),
    getDeploymentManagedReadToken(client),
  ]);
  if (adminToken instanceof Error) {
    tokenSpinner.stop("Failed to create admin token");
    clack.log.error(adminToken.message);
    return proc.exit(1);
  }
  if (readToken instanceof Error) {
    tokenSpinner.stop("Failed to create read token");
    clack.log.error(readToken.message);
    return proc.exit(1);
  }

  tokenSpinner.stop("Tokens created");

  // Save Tinybird config to the Strada database
  const saveSpinner = clack.spinner();
  saveSpinner.start("Saving database config to Strada...");

  const { safeFetch } = getApiClient();
  const saveRes = await safeFetch("/api/v0/orgs/:orgId/database", {
    method: "PUT",
    params: { orgId: org.id },
    body: {
      backend: "tinybird" as const,
      tinybirdEndpoint: auth.baseUrl,
      tinybirdAdminToken: adminToken.token,
      tinybirdReadToken: readToken.token,
    },
  });
  if (saveRes instanceof Error) {
    saveSpinner.stop("Failed to save config");
    clack.log.error(saveRes.message);
    return proc.exit(1);
  }
  saveSpinner.stop("Database config saved");

  clack.log.success("Strada is deployed to your Tinybird workspace and config is saved!");

  output.log("");
  output.log(bold("Next steps:"));
  output.log(`  1. Create a project: ${cyan("strada projects create my-app")}`);
  output.log(`  2. Configure your SDK with the project's ingest endpoint`);
  output.log("");

  clack.outro("Done");
}

export async function databaseUpgradeAction(
  { console: output, process: proc }: GokeExecutionContext,
) {
  clack.intro(bold("Strada — Database schema upgrade"));

  try {
    requireAuth();
  } catch (e) {
    clack.log.error((e as Error).message);
    return proc.exit(1);
  }

  const org = await resolveCurrentOrg().catch((error) => error as Error);
  if (org instanceof Error) {
    clack.log.error(org.message);
    return proc.exit(1);
  }
  clack.log.info(`Using organization: ${cyan(org.name)}`);

  const spinner = clack.spinner();
  spinner.start("Upgrading database schema...");

  const { safeFetch } = getApiClient();
  const result = await safeFetch("/api/v0/orgs/:orgId/database/migrate", {
    method: "POST",
    params: { orgId: org.id },
  });

  if (result instanceof Error) {
    spinner.stop("Upgrade failed");
    clack.log.error(result.message);
    return proc.exit(1);
  }

  spinner.stop(result.result === "no_changes" ? "Schema already up to date" : "Schema upgraded");

  output.log("");
  output.log(bold("Upgrade summary:"));
  output.log(`  Result: ${cyan(result.result)}`);
  output.log(`  Backend: ${cyan(result.backend)}`);
  output.log(`  Endpoint: ${cyan(result.tinybirdEndpoint)}`);
  output.log("");

  clack.outro("Done");
}
