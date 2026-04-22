// OTel collector — receives OTLP HTTP/JSON and forwards to Tinybird or ClickHouse.
//
// Config resolution: the collector shares a D1 binding with the website.
// On each request, it extracts the project ID from the hostname, queries D1
// for the project's database credentials, and creates the appropriate backend.
//
// Project isolation: project_id is the ULID from the `project` table.
// Each project gets a subdomain: {projectId}-ingest.strada.sh

import { env } from "cloudflare:workers";
import { Spiceflow } from "spiceflow";
import { cors } from "spiceflow/cors";
import { datasources } from "./env.ts";
import { getProjectId } from "./get-project-id.ts";
import { resolveProjectConfig } from "./resolve-config.ts";
import { transformTraces } from "./transform-traces.ts";
import { transformLogs } from "./transform-logs.ts";
import { transformMetrics } from "./transform-metrics.ts";
import { createBackend } from "./backend.ts";
import { extractErrorsFromTraces, extractErrorsFromLogs } from "./extract-errors.ts";
import type { ExportTraceServiceRequest, ExportLogsServiceRequest, ExportMetricsServiceRequest } from "./otlp-types.ts";

async function resolveOrFail(projectId: string) {
  if (!projectId) {
    throw new Response(JSON.stringify({ error: "missing project id in hostname" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }
  const config = await resolveProjectConfig(env.DB, projectId);
  if (!config) {
    throw new Response(JSON.stringify({ error: `unknown project: ${projectId}` }), {
      status: 404, headers: { "content-type": "application/json" },
    });
  }
  return config;
}

const app = new Spiceflow()
  .use(
    cors({
      origin: "*",
      allowMethods: ["POST"],
      allowHeaders: ["content-type", "authorization"],
      maxAge: 86400,
    }),
  )
  .post("/v1/traces", async ({ request, waitUntil }) => {
    const projectId = getProjectId(request);
    const config = await resolveOrFail(projectId);

    const body = (await request.json()) as ExportTraceServiceRequest;
    const backend = createBackend(config);
    const country = request.headers.get("cf-ipcountry") ?? undefined;
    const userAgent = request.headers.get("user-agent") ?? undefined;

    const ndjson = transformTraces(body, projectId, { country, userAgent });
    if (ndjson) {
      waitUntil(backend.send(datasources.traces, "traces", ndjson));
    }

    const errorsNdjson = extractErrorsFromTraces(body, projectId);
    if (errorsNdjson) {
      waitUntil(backend.send(datasources.errors, "errors", errorsNdjson));
    }

    return {};
  })
  .post("/v1/logs", async ({ request, waitUntil }) => {
    const projectId = getProjectId(request);
    const config = await resolveOrFail(projectId);

    const body = (await request.json()) as ExportLogsServiceRequest;
    const backend = createBackend(config);

    const ndjson = transformLogs(body, projectId);
    if (ndjson) {
      waitUntil(backend.send(datasources.logs, "logs", ndjson));
    }

    const errorsNdjson = extractErrorsFromLogs(body, projectId);
    if (errorsNdjson) {
      waitUntil(backend.send(datasources.errors, "errors", errorsNdjson));
    }

    return {};
  })
  .post("/v1/metrics", async ({ request, waitUntil }) => {
    const projectId = getProjectId(request);
    const config = await resolveOrFail(projectId);

    const body = (await request.json()) as ExportMetricsServiceRequest;
    const backend = createBackend(config);
    const payloads = transformMetrics(body, projectId, {
      gauge: datasources.gauge,
      sum: datasources.sum,
      histogram: datasources.histogram,
      exponentialHistogram: datasources.exponentialHistogram,
    });

    const toSend = payloads.filter((p) => p.ndjson.length > 0);
    if (toSend.length > 0) {
      waitUntil(Promise.all(toSend.map((p) => backend.send(p.datasource, p.signal, p.ndjson))));
    }

    return {};
  });

export default {
  fetch(request: Request): Promise<Response> {
    return app.handle(request);
  },
} satisfies ExportedHandler<Env>;

export { app };
