// Main Strada CLI entrypoint. Composes sub-CLIs and wires help/version output.

import { goke } from "goke";
import packageJson from "../package.json" with { type: "json" };
import { selfhostCli } from "./selfhost.ts";
import { loginCli } from "./login.ts";
import { projectsCli } from "./projects.ts";

export const cli = goke("strada")
  .use(selfhostCli)
  .use(loginCli)
  .use(projectsCli);

cli.help();
cli.version(packageJson.version);
