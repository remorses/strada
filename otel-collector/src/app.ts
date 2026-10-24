// Collector app factory shared by the Cloudflare worker entry and Vitest integration tests.

import { Spiceflow } from "spiceflow";
import { cors } from "spiceflow/cors";
import { trace } from "@strada.sh/sdk";
import { datasources } from "./env.ts";
import { getProjectId } from "./get-project-id.ts";
import { resolveProjectConfig } from "./resolve-config.ts";
import { transformTraces } from "./transform-traces.ts";
import { transformLogs } from "./transform-logs.ts";
import { transformMetrics } from "./transform-metrics.ts";
import { createBackend } from "./backend.ts";
import { extractErrorsFromTraces, extractErrorsFromLogs } from "./extract-errors.ts";
import { extractUsersFromLogs } from "./extract-users.ts";
import type { ExportBatchServiceRequest } from "./otlp-types.ts";

interface OtlpRequest {
  url: string;
  headers: Headers;
  body: ReadableStream | null;
  json(): Promise<unknown>;
}

interface IngestRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getBearerToken(request: OtlpRequest): string | null {
  const header = request.headers.get("authorization");
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1]?.trim() || null;
}

async function validateIngestToken({
  db,
  orgId,
  token,
}: {
  db: D1Database;
  orgId: string;
  token: string;
}): Promise<boolean> {
  const hashed = await hashToken(token);
  const row = await db.prepare(`
    SELECT id
    FROM org_token
    WHERE org_id = ? AND hashed_key = ? AND scope = 'ingest'
    LIMIT 1
  `).bind(orgId, hashed).first<{ id: string }>();

  return Boolean(row);
}

async function requireIngestAccess({
  db,
  request,
  projectId,
  orgId,
  anonymousRateLimiter,
}: {
  db: D1Database;
  request: OtlpRequest;
  projectId: string;
  orgId: string;
  anonymousRateLimiter?: IngestRateLimiter;
}): Promise<boolean> {
  const token = getBearerToken(request);
  if (token) {
    const valid = await validateIngestToken({ db, orgId, token });
    if (!valid) {
      throw new Response(JSON.stringify({ error: "invalid ingest token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return true;
  }

  if (!anonymousRateLimiter) return false;

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await anonymousRateLimiter.limit({ key: `anonymous-ingest:${projectId}:${ip}` });
  if (!success) {
    throw new Response(JSON.stringify({ error: "anonymous ingest rate limit exceeded" }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  }

  return false;
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

/**
 * Transform one OTLP body and write every table it touches. The standard
 * `/v1/*` routes read only their own signal (`only`); `/v1/batch` reads all three.
 */
async function ingest({
  db,
  request,
  anonymousRateLimiter,
  only,
}: {
  db: D1Database;
  request: OtlpRequest;
  anonymousRateLimiter?: IngestRateLimiter;
  only?: keyof ExportBatchServiceRequest;
}): Promise<Record<string, never>> {
  const projectId = getProjectId(request);
  const config = await resolveOrFail({ db, projectId });
  const authenticated = await requireIngestAccess({ db, request, projectId, orgId: config.orgId, anonymousRateLimiter });

  const parsed = await parseOtlpRequest<ExportBatchServiceRequest>(request);
  const payload: ExportBatchServiceRequest = only ? { [only]: parsed[only] } : parsed;
  const backend = createBackend(config);
  const country = request.headers.get("cf-ipcountry") ?? undefined;
  const userAgent = request.headers.get("user-agent") ?? undefined;

  const tracesNdjson = transformTraces(payload, projectId, { country, userAgent });
  const logsNdjson = transformLogs(payload, projectId);
  // Both extractors end rows with "\n", so concatenation is valid NDJSON.
  const errorsNdjson = extractErrorsFromTraces(payload, projectId) + extractErrorsFromLogs(payload, projectId);
  const usersNdjson = authenticated ? extractUsersFromLogs(payload, projectId) : "";
  const metrics = transformMetrics(payload, projectId, {
    gauge: datasources.gauge,
    sum: datasources.sum,
    histogram: datasources.histogram,
    exponentialHistogram: datasources.exponentialHistogram,
  });

  // Await all writes so data is queryable when the SDK reports "export
  // succeeded." Using waitUntil() here would return 200 before data reaches
  // Tinybird/ClickHouse, causing noticeable lag (especially for traces which
  // trigger 2 materialized views on INSERT). Parallel sends keep total
  // latency = max(individual writes), not sum.
  const sends: Promise<void>[] = [];
  if (tracesNdjson) sends.push(backend.send(datasources.traces, "traces", tracesNdjson));
  if (logsNdjson) sends.push(backend.send(datasources.logs, "logs", logsNdjson));
  if (errorsNdjson) sends.push(backend.send(datasources.errors, "errors", errorsNdjson));
  if (usersNdjson) sends.push(backend.send(datasources.users, "users", usersNdjson));
  for (const metric of metrics) {
    if (metric.ndjson) sends.push(backend.send(metric.datasource, metric.signal, metric.ndjson));
  }
  await Promise.all(sends);

  return {};
}

export function createCollectorApp({ db, anonymousRateLimiter }: { db: D1Database; anonymousRateLimiter?: IngestRateLimiter }) {
  const tracer = trace.getTracer("strada-otel-collector");

  return new Spiceflow({ tracer })
    .use(
      cors({
        origin: "*",
        allowMethods: ["POST"],
        allowHeaders: ["content-type", "authorization"],
        maxAge: 86400,
      }),
    )
    .post("/v1/traces", ({ request }) => ingest({ db, request, anonymousRateLimiter, only: "resourceSpans" }))
    .post("/v1/logs", ({ request }) => ingest({ db, request, anonymousRateLimiter, only: "resourceLogs" }))
    .post("/v1/metrics", ({ request }) => ingest({ db, request, anonymousRateLimiter, only: "resourceMetrics" }))
    // Strada SDK route: traces, logs, and metrics of one flush in one request,
    // because Cloudflare bills this Worker per inbound request.
    .post("/v1/batch", ({ request }) => ingest({ db, request, anonymousRateLimiter }));
}
