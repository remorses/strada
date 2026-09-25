import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const packageDir = path.resolve(import.meta.dirname, "..");

// ESM app: the static `import http from "node:http"` is loaded before any app code runs.
const APP = `
import http from "node:http";
import { initStrada, shutdown } from "@strada.sh/sdk";
initStrada({ projectId: "", endpoint: process.env.RECEIVER, service: "app", enabled: true, captureUncaughtErrors: false });
const server = http.createServer((_req, res) => res.end("ok"));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
await new Promise((resolve) => http.get("http://127.0.0.1:" + server.address().port + "/users", (res) => { res.resume(); res.on("end", resolve); }));
server.close();
await shutdown();
`;

async function spanNamesFor(nodeArgs: string[]): Promise<string[]> {
  const names: string[] = [];
  const receiver = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.url === "/v1/traces") {
        const parsed = JSON.parse(body) as {
          resourceSpans: Array<{ scopeSpans: Array<{ scope: { name: string }; spans: Array<{ name: string }> }> }>;
        };
        names.push(
          ...parsed.resourceSpans.flatMap((resource) =>
            resource.scopeSpans.flatMap((scope) => scope.spans.map((span) => `${scope.scope.name} ${span.name}`)),
          ),
        );
      }
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const { port } = receiver.address() as { port: number };
  // cwd inside the package, so bare specifiers resolve through the self-reference and devDependencies.
  await execFileAsync(process.execPath, [...nodeArgs, "--input-type=module", "-e", APP], {
    cwd: packageDir,
    env: { ...process.env, RECEIVER: `http://127.0.0.1:${port}`, NODE_OPTIONS: "" },
  });
  receiver.close();
  return names.sort();
}

test("the preload patches ESM modules that the app loads; app code alone cannot", async () => {
  expect({
    instrumentationRegister: await spanNamesFor(["--import", "@strada.sh/instrumentation/register"]),
    sdkRegister: await spanNamesFor(["--import", "@strada.sh/sdk/register"]),
    noPreload: await spanNamesFor([]),
  }).toMatchInlineSnapshot(`
    {
      "instrumentationRegister": [
        "@opentelemetry/instrumentation-http GET",
        "@opentelemetry/instrumentation-http GET",
      ],
      "noPreload": [],
      "sdkRegister": [
        "@opentelemetry/instrumentation-http GET",
        "@opentelemetry/instrumentation-http GET",
      ],
    }
  `);
}, 60_000);
