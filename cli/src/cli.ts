// Main Strada CLI entrypoint. Composes sub-CLIs and wires help/version output.
//
// Shebang is `node` so all CLI subcommands work without Bun.
// Only the default TUI command requires Bun (OpenTUI Zig FFI). When
// invoked under Node, the TUI re-spawns itself with `bun` via spawnSync.

import { goke } from "goke";
import dedent from "string-dedent";
import packageJson from "../package.json" with { type: "json" };
import { databaseCli } from "./database.ts";
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

export const cli = goke("strada")
  .use(databaseCli)
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

// ── Default command (TUI) ─────────────────────────────────────────

cli.command(
  "",
  dedent`
    Launch the interactive TUI to browse issues, logs, traces, and analytics.

    Requires Bun for the terminal renderer. If invoked under Node, it
    re-spawns itself with bun automatically. Switch views and projects
    with Ctrl+P, filter services with Ctrl+K.
  `,
).action(async () => {
  // OpenTUI's Zig renderer requires Bun FFI. When running under Node,
  // re-spawn the same command with bun so the TUI works transparently.
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  if (!isBun) {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    // import.meta.url resolves to cli.js, but we need bin.js (the
    // entrypoint that calls cli.parse()). Without this, bun loads cli.js
    // which only exports the cli object and never calls .parse(), so the
    // TUI silently exits with code 0.
    const binPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "bin.js",
    );
    const result = spawnSync("bun", [binPath, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: process.env,
    });
    if (result.error) {
      const isWindows = process.platform === "win32";
      const installCmd = isWindows
        ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
        : "curl -fsSL https://bun.sh/install | bash";
      console.error(
        "Error: The TUI requires Bun to run.\n\n" +
          "Install Bun:\n" +
          `  ${installCmd}\n\n` +
          "Then run:\n" +
          "  strada",
      );
      process.exit(1);
    }
    if (result.signal) {
      process.kill(process.pid, result.signal);
      return;
    }
    process.exit(result.status ?? 1);
    return;
  }

  const React = await import("react");
  const { initializeExtension, renderWithProviders } = await import("termcast");
  initializeExtension({ extensionName: "strada" });
  const { default: StradaTui } = await import("./tui/index.js");
  await renderWithProviders(React.createElement(StradaTui), {
    extensionName: "strada",
  });
});

cli.help();
cli.version(packageJson.version);
