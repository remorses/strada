// Main Strada CLI entrypoint. Composes sub-CLIs and wires help/version output.

import { goke } from "goke";
import packageJson from "../package.json" with { type: "json" };
import { selfhostCli } from "./selfhost.ts";

export const cli = goke("strada").use(selfhostCli);

cli.help();
cli.version(packageJson.version);
