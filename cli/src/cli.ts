// Main Strada CLI entrypoint. Composes sub-CLIs and wires help/version output.

import { goke } from "goke";
import packageJson from "../package.json" with { type: "json" };
import { databaseCli } from "./database.ts";
import { loginCli } from "./login.ts";
import { orgsCli } from "./orgs.ts";
import { projectsCli } from "./projects.ts";
import { issuesCli } from "./issues.ts";
import { analyticsCli } from "./analytics.ts";
import { queryCli } from "./query.ts";

export const cli = goke("strada")
  .use(databaseCli)
  .use(loginCli)
  .use(orgsCli)
  .use(projectsCli)
  .use(issuesCli)
  .use(analyticsCli)
  .use(queryCli);

cli.help();
cli.version(packageJson.version);
