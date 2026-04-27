// Collector app factory shared by the Cloudflare worker entry and Vitest integration tests.

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
import type {
  ExportTraceServiceRequest,
  ExportLogsServiceRequest,
  ExportMetricsServiceRequest,
} from "./otlp-types.ts";

interface OtlpRequest {
  headers: Headers;
  body: ReadableStream | null;
  json(): Promise<unknown>;
}

async function parseOtlpRequest<T>(request: OtlpRequest): Promise<T> {
  const contentEncoding = request.headers.get("content-encoding");
  if (!contentEncoding || contentEncoding.toLowerCase() === "identity") {
    return (await request.json()) as T;
  }

  // Cloudflare Workers destinations send OTLP payloads with gzip compression.
  // Decode here so the collector accepts the real export shape instead of only
  // local SDK traffic, which often arrives uncompressed.
  let stream = request.body;
  if (!stream) {
    throw new Response(JSON.stringify({ error: "missing request body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const encodings = contentEncoding.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean).reverse();
  for (const encoding of encodings) {
    if (encoding === "gzip" || encoding === "x-gzip") {
      stream = stream.pipeThrough(new DecompressionStream("gzip"));
      continue;
    }
    if (encoding === "deflate") {
      stream = stream.pipeThrough(new DecompressionStream("deflate"));
      continue;
    }

    throw new Response(JSON.stringify({ error: `unsupported content-encoding: ${encoding}` }), {
      status: 415,
      headers: { "content-type": "application/json" },
    });
  }

  const text = await new Response(stream).text();
  return JSON.parse(text) as T;
}

async function resolveOrFail({
  db,
  projectId,
}: {
  db: D1Database;
  projectId: string;
}) {
  if (!projectId) {
    throw new Response(JSON.stringify({ error: "missing project id in hostname" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }

  const config = await resolveProjectConfig(db, projectId);
  if (!config) {
    throw new Response(JSON.stringify({ error: `unknown project: ${projectId}` }), {
      status: 404, headers: { "content-type": "application/json" },
    });
  }

  return config;
}

export function createCollectorApp({ db }: { db: D1Database }) {
  return new Spiceflow()
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
      const config = await resolveOrFail({ db, projectId });

      const body = await parseOtlpRequest<ExportTraceServiceRequest>(request);
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
      const config = await resolveOrFail({ db, projectId });

      const body = await parseOtlpRequest<ExportLogsServiceRequest>(request);
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
      const config = await resolveOrFail({ db, projectId });

      const body = await parseOtlpRequest<ExportMetricsServiceRequest>(request);
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
}
