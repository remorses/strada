// Typed API client for the Strada website. Uses spiceflow's typed fetch client
// with the website App type imported from source for compile-time route validation.
//
// The App type is imported from "strada-website/src/app.tsx" (source, not dist).
// This avoids build-order dependencies: the website doesn't need to be built for
// the CLI to typecheck. Ambient stubs in website-stubs.d.ts cover modules that
// don't resolve under the CLI's nodenext resolution (echarts, etc).
//
// Prefer getApiClient() which reads auth from config automatically.
// Use createApiClient() only when you have explicit credentials (e.g. database create).
//
// The safeFetch client accepts `body` as a plain object (auto-serialized to JSON)
// and is fully type-safe on path params, query, body, and response. No need for
// JSON.stringify() or Content-Type headers. Auth header is set globally on the client.

import { createSpiceflowFetch } from "spiceflow/client";
import type { App } from "strada-website/src/app.tsx";
import { requireAuth, type AuthCtx } from "./config.ts";
import { inProcessMcp } from "./mcp-request.ts";

export function createApiClient(opts: {
  baseUrl: string
  sessionToken: string
  fetch?: typeof fetch
}) {
  const safeFetch = createSpiceflowFetch<App>(opts.baseUrl, {
    headers: { Authorization: `Bearer ${opts.sessionToken}` },
    fetch: opts.fetch,
  });
  return { safeFetch };
}

/** Create an API client from the stored auth config. Throws if not logged in. */
export function getApiClient(ctx?: AuthCtx) {
  const mcp = inProcessMcp.getStore();
  if (mcp) return createApiClient({ baseUrl: mcp.baseUrl, sessionToken: "mcp", fetch: mcp.fetch });
  const auth = requireAuth(ctx);
  return createApiClient({ baseUrl: auth.baseUrl, sessionToken: auth.sessionToken });
}

// ── Query execution ───────────────────────────────────────────────

export interface QueryResult {
  data?: Array<Record<string, unknown>>;
  meta?: Array<{ name: string; type?: string }>;
  rows?: number;
  statistics?: { elapsed: number; rows_read?: number; bytes_read?: number };
  raw?: string;
}

/** Run a SQL query against a project via the website API. */
export async function queryProject(projectId: string, sql: string): Promise<QueryResult> {
  const { safeFetch } = getApiClient();
  const res = await safeFetch("/api/v0/projects/:projectId/query", {
    method: "POST",
    params: { projectId },
    body: { sql },
  });
  if (res instanceof Error) throw res;
  return res as QueryResult;
}
