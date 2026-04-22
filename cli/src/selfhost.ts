// Self-hosted Tinybird setup command.
//
// Tinybird browser auth lives in tinybird-browser-login.ts because the local
// callback server is easier to reason about as a small isolated module.

import * as clack from "@clack/prompts";
import { goke } from "goke";
import type { GokeExecutionContext } from "goke";
import picocolors from "picocolors";
import dedent from "string-dedent";
import { browserLogin } from "./tinybird-browser-login.ts";
import { loadTinybirdResources } from "./tinybird-resources.ts";
import { TinybirdClient } from "./tinybird.ts";

export interface SelfhostOptions {
  token?: string;
  baseUrl?: string;
}

export const selfhostCli = goke();

selfhostCli
  .command(
    "selfhost",
    dedent`
      Set up Strada on your own Tinybird workspace.

      Authenticates with Tinybird via browser OAuth, then deploys all OTel
      datasources and materialized views to your workspace. Outputs the
      environment variables needed to configure the otel-collector.

      For non-interactive usage (CI), pass --token and --base-url directly.
    `,
  )
  .option("-t, --token [token]", "Tinybird workspace admin token (skips browser login)")
  .option("-u, --base-url [url]", "Tinybird API base URL (e.g. https://api.us-east.aws.tinybird.co)")
  .example("# Interactive setup (opens browser)")
  .example("strada selfhost")
  .example("# Non-interactive with existing token")
  .example("strada selfhost --token p.eyXXX --base-url https://api.tinybird.co")
  .action((options, context) => selfhostAction(options, context));

async function deployResources(
  client: TinybirdClient,
  datasources: Array<{ name: string; content: string }>,
  pipes: Array<{ name: string; content: string }>,
): Promise<{ success: boolean; error?: string; errors?: Array<{ filename?: string; error: string }> }> {
  try {
    for (const deployment of await client.listDeployments()) {
      if (!deployment.live && deployment.status !== "live") {
        await client.deleteDeployment(deployment.id);
      }
    }
  } catch {
    // Ignore cleanup errors and try deployment anyway.
  }

  const deployResponse = await client.createDeployment({ datasources, pipes });

  if (deployResponse.result === "failed") {
    const errors = deployResponse.errors ?? deployResponse.deployment?.errors;
    return {
      success: false,
      ...(deployResponse.error !== undefined ? { error: deployResponse.error } : undefined),
      ...(errors !== undefined ? { errors } : undefined),
    };
  }

  if (deployResponse.result === "no_changes") {
    return { success: true };
  }

  const deploymentId = deployResponse.deployment?.id;
  if (!deploymentId) {
    return { success: false, error: "No deployment ID in Tinybird response" };
  }

  for (let i = 0; i < 120; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const statusResponse = await client.getDeploymentStatus(deploymentId);

    if (statusResponse.deployment.status === "data_ready") {
      break;
    }

    if (statusResponse.deployment.status === "failed" || statusResponse.deployment.status === "error") {
      return { success: false, error: `Deployment failed with status ${statusResponse.deployment.status}` };
    }
  }

  try {
    await client.promoteDeployment(deploymentId);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return { success: true };
}

export async function selfhostAction(
  options: SelfhostOptions,
  { console: output, process }: GokeExecutionContext,
) {
  clack.intro(picocolors.bold("Strada — Self-hosted Tinybird setup"));

  let token = options.token;
  let baseUrl = options.baseUrl;

  if (token && baseUrl) {
    clack.log.info(`Using provided token for ${baseUrl}`);
  } else if (token && !baseUrl) {
    clack.log.error("--base-url is required when using --token");
    return process.exit(1);
  } else {
    clack.log.info("Opening browser to authenticate with Tinybird...");

    try {
      const auth = await browserLogin();
      token = auth.token;
      baseUrl = auth.baseUrl;

      const workspace = await new TinybirdClient({ baseUrl, token }).getWorkspace();

      clack.log.success(
        `Authenticated as ${picocolors.cyan(workspace.user_email)} ` + `in workspace ${picocolors.cyan(workspace.name)}`,
      );
    } catch (error) {
      clack.log.error(error instanceof Error ? error.message : String(error));
      return process.exit(1);
    }
  }

  if (!token || !baseUrl) {
    clack.log.error("Tinybird authentication did not return a token and base URL");
    return process.exit(1);
  }

  const client = new TinybirdClient({ baseUrl, token });

  const spinner = clack.spinner();
  spinner.start("Loading Tinybird resource files...");

  let resources;
  try {
    resources = loadTinybirdResources();
  } catch (error) {
    spinner.stop("Failed to load resources");
    clack.log.error(error instanceof Error ? error.message : String(error));
    return process.exit(1);
  }

  spinner.message(`Found ${resources.datasources.length} datasources, ${resources.pipes.length} pipes`);
  spinner.message("Deploying to Tinybird...");

  try {
    const result = await deployResources(client, resources.datasources, resources.pipes);
    if (!result.success) {
      spinner.stop("Deployment failed");
      if (result.error) clack.log.error(result.error);
      if (result.errors?.length) {
        for (const error of result.errors) {
          clack.log.error(`  ${error.filename || ""}: ${error.error}`);
        }
      }
      return process.exit(1);
    }

    spinner.stop("Deployed successfully");
  } catch (error) {
    spinner.stop("Deployment failed");
    clack.log.error(error instanceof Error ? error.message : String(error));
    return process.exit(1);
  }

  clack.log.success("Strada is deployed to your Tinybird workspace!");

  output.log("");
  output.log(picocolors.bold("Add these environment variables to your otel-collector:"));
  output.log("");
  output.log(`  ${picocolors.cyan("TINYBIRD_ENDPOINT")}=${baseUrl}`);
  output.log(`  ${picocolors.cyan("TINYBIRD_TOKEN")}=${token}`);
  output.log("");
  output.log(picocolors.dim("ProjectId is always empty string for self-hosted — no row-level filtering needed."));
  output.log(picocolors.dim("For reads, use this same workspace admin token with Tinybird /v0/sql queries."));

  clack.outro("Done");
}
