import { goke } from "goke";
import { loginCli } from "./login.ts";
import { orgsCli } from "./orgs.ts";
import { projectsCli } from "./projects.ts";
import { issuesCli } from "./issues.ts";
import { analyticsCli } from "./analytics.ts";
import { queryCli } from "./query.ts";
import { alertsCli } from "./alerts.ts";
import { logsCli } from "./logs.ts";
import { servicesCli } from "./services.ts";
import { tracesCli } from "./traces.ts";
import { tokensCli } from "./tokens.ts";
import { checksCli } from "./checks.ts";
import { destinationsCli } from "./destinations.ts";

const MCP_EXCLUDED_COMMANDS = new Set([
  "login",
  "logout",
  "database create",
  "database upgrade",
  "projects retention update",
  "mcp",
]);

export function isMcpCommand(name: string): boolean {
  if (MCP_EXCLUDED_COMMANDS.has(name)) return false;
  if (name.startsWith("completions")) return false;
  return true;
}

export function buildCli() {
  return goke("strada")
    .use(loginCli)
    .use(orgsCli)
    .use(projectsCli)
    .use(issuesCli)
    .use(analyticsCli)
    .use(queryCli)
    .use(alertsCli)
    .use(checksCli)
    .use(destinationsCli)
    .use(logsCli)
    .use(servicesCli)
    .use(tracesCli)
    .use(tokensCli);
}
