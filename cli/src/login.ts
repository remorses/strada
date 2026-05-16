// Login command — authenticates with the Strada website via BetterAuth device flow.
// Opens the browser for the user to approve, polls until approved, saves the token.

import * as clack from "@clack/prompts";
import dedent from "string-dedent";
import { goke, openInBrowser } from "goke";
import type { GokeExecutionContext } from "goke";
import { bold, cyan } from "./colors.ts";
import { getResolvedConfig, saveConfig, getBaseUrl, setScope } from "./config.ts";

export const loginCli = goke();

const CLI_CLIENT_ID = "strada-cli"

async function readJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

function getLoginInteractivityError() {
  return dedent`
    strada login needs an interactive terminal and must stay alive while you approve the browser login.

    Refusing to start because stdout is not attached to a TTY.

    Run it in a background terminal session like tuistory or tmux, then wait for the URL/code:

      bunx tuistory launch "strada login" -s strada-login
      bunx tuistory -s strada-login wait "/Your code:|https?:\\/\\//i" --timeout 15000

    The login command exits by itself after successful browser approval.
  `;
}

loginCli
  .command("login", "Authenticate with Strada via browser login")
  .option("-u, --url [url]", "Strada website URL (default: https://strada.sh)")
  .action((options, ctx) => loginAction(options, ctx));

loginCli
  .command("logout", "Remove stored authentication")
  .action((_options, ctx) => logoutAction(ctx));

loginCli
  .command("whoami", "Show current authenticated user")
  .action((_options, ctx) => whoamiAction(ctx));

async function loginAction(
  options: { url?: string },
  { console: output, process: proc }: GokeExecutionContext,
) {
  if (!process.stdout.isTTY) {
    output.error(getLoginInteractivityError());
    return proc.exit(1);
  }

  const baseUrl = options.url || getBaseUrl();
  clack.intro(bold("Strada — Login"));

  // Step 1: Request a device code from the website
  clack.log.info("Requesting device code...");
  const deviceRes = await fetch(new URL("/api/auth/device/code", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLI_CLIENT_ID }),
  });

  if (!deviceRes.ok) {
    const text = await deviceRes.text();
    clack.log.error(`Failed to request device code: ${deviceRes.status} ${text}`);
    return proc.exit(1);
  }

  const deviceData = await readJson<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  }>(deviceRes);

  const verificationUrl = deviceData.verification_uri_complete ||
    `${baseUrl}${deviceData.verification_uri}?user_code=${deviceData.user_code}`;

  clack.log.info(`Your code: ${bold(cyan(deviceData.user_code))}`);
  clack.log.info(`Opening browser to approve...`);
  await openInBrowser(verificationUrl);

  // Step 2: Poll until approved
  const spinner = clack.spinner();
  spinner.start("Waiting for approval...");

  const pollInterval = (deviceData.interval || 5) * 1000;
  const deadline = Date.now() + (deviceData.expires_in || 300) * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const pollRes = await fetch(new URL("/api/auth/device/token", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceData.device_code,
        client_id: CLI_CLIENT_ID,
      }),
    });

    if (pollRes.ok) {
      const result = await readJson<{ access_token?: string }>(pollRes);
      const token = result.access_token;
      if (token) {
        spinner.stop("Approved!");
        setScope("/", { sessionToken: token, baseUrl });
        clack.log.success(`Logged in to ${cyan(baseUrl)}`);
        clack.outro("Done");
        return;
      }
    }

    const pollBody: { error?: string } = await readJson<{ error?: string }>(pollRes).catch(() => ({}));
    if (pollBody.error === "expired_token") {
      spinner.stop("Code expired");
      clack.log.error("Device code expired. Run `strada login` again.");
      return proc.exit(1);
    }
    if (pollBody.error === "access_denied") {
      spinner.stop("Denied");
      clack.log.error("Login was denied.");
      return proc.exit(1);
    }
    // authorization_pending or slow_down — keep polling
  }

  spinner.stop("Timed out");
  clack.log.error("Login timed out. Run `strada login` again.");
  return proc.exit(1);
}

async function logoutAction({ console: output }: GokeExecutionContext) {
  saveConfig({});
  output.log("Logged out.");
}

async function whoamiAction({ console: output, process: proc }: GokeExecutionContext) {
  const config = getResolvedConfig();
  if (!config.sessionToken) {
    output.log("Not logged in. Run `strada login` first.");
    return proc.exit(1);
  }
  const baseUrl = config.baseUrl || "https://strada.sh";
  const res = await fetch(new URL("/api/auth/get-session", baseUrl), {
    headers: { Authorization: `Bearer ${config.sessionToken}` },
  });
  if (!res.ok) {
    output.log("Session expired or invalid. Run `strada login` again.");
    return proc.exit(1);
  }
  const session = await readJson<{ user?: { name?: string; email?: string } }>(res);
  output.log(`Logged in as ${session.user?.name || "unknown"} (${session.user?.email || "unknown"})`);
  output.log(`Server: ${baseUrl}`);
}
