// Self-hosted Tinybird setup command.
// Requires `strada login` first. After deploying Tinybird resources,
// saves the tokens to the Strada database via the website API.

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
import { ensureDefaultOrg } from "./projects.ts";

export interface SelfhostOptions {
  token?: string;
  baseUrl?: string;
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

export const selfhostCli = goke();

selfhostCli
  .command(
    "selfhost",
    dedent`
      Set up Strada on your own Tinybird workspace.

      Requires \`strada login\` first. Authenticates with Tinybird via browser
      OAuth, deploys OTel datasources and materialized views, then saves the
      tokens to your Strada database.

      For non-interactive Tinybird auth, pass --token and --base-url directly.
    `,
  )
  .option("-t, --token [token]", "Tinybird workspace admin token (skips browser login)")
  .option("-u, --base-url [url]", "Tinybird API base URL (e.g. https://api.us-east.aws.tinybird.co)")
  .example("# Interactive setup (opens browser)")
  .example("strada selfhost")
  .example("# Non-interactive with existing token")
  .example("strada selfhost --token p.eyXXX --base-url https://api.tinybird.co")
  .action((options, context) => selfhostAction(options, context));

selfhostCli
  .command(
    "selfhost migrate",
    dedent`
      Update the Tinybird schema for the current organization's saved self-hosted workspace.

      Requires \

      `,
  )
  .action(async (_options, context) => selfhostMigrateAction(context));

export async function selfhostAction(
  options: SelfhostOptions,
  { console: output, process: proc }: GokeExecutionContext,
) {
  clack.intro(bold("Strada — Self-hosted Tinybird setup"));

  // Require Strada login first
  let stradaAuth: { sessionToken: string; baseUrl: string };
  try {
    stradaAuth = requireAuth();
  } catch (e) {
    clack.log.error((e as Error).message);
    return proc.exit(1);
  }

  // Create a default personal org on first use so `strada login` -> `strada selfhost`
  // works end to end without a manual org bootstrap step.
  const org = await ensureDefaultOrg().catch((error) => error as Error);
  if (org instanceof Error) {
    clack.log.error(org.message);
    return proc.exit(1);
  }
  clack.log.info(`Using organization: ${cyan(org.name)}`);

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
      return new Error("Tinybird login needs browser interaction. Run `strada selfhost` in a background terminal session with tuistory or tmux, or re-run with --token and --base-url (or TINYBIRD_TOKEN and TINYBIRD_BASE_URL).")
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
      clack.outro("Cancelled. Create a new dedicated Tinybird workspace and re-run strada selfhost.");
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

  const deployment = await deployResources({ client, datasources: resources.datasources, pipes: resources.pipes });
  if (deployment instanceof Error) {
    spinner.stop("Deployment failed");
    clack.log.error(deployment.message);
    return proc.exit(1);
  }

  spinner.stop("Deployed successfully");

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
  const saveRes = await safeFetch("/api/orgs/:orgId/database", {
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
