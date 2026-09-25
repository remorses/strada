import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const sdkDir = path.resolve(import.meta.dirname, "..");

test("--import @strada.sh/sdk/register warns and the app still runs when @strada.sh/instrumentation is not installed", async () => {
  // Real install layout with only the SDK: <app>/node_modules/@strada.sh/sdk (package.json + dist).
  const appDir = await fs.mkdtemp(path.join(os.tmpdir(), "strada-register-"));
  const installed = path.join(appDir, "node_modules/@strada.sh/sdk");
  await fs.mkdir(installed, { recursive: true });
  await fs.cp(path.join(sdkDir, "package.json"), path.join(installed, "package.json"));
  await fs.cp(path.join(sdkDir, "dist"), path.join(installed, "dist"), { recursive: true });

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--import", "@strada.sh/sdk/register", "--input-type=module", "-e", 'console.log("app ran")'],
    { cwd: appDir, env: { ...process.env, NODE_OPTIONS: "" } },
  );
  await fs.rm(appDir, { recursive: true, force: true });
  expect({ stdout, stderr }).toMatchInlineSnapshot(`
    {
      "stderr": "[@strada.sh/sdk] auto-instrumentation is off: install @strada.sh/instrumentation (npm install @strada.sh/instrumentation)
    ",
      "stdout": "app ran
    ",
    }
  `);
});
