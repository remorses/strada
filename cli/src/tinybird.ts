// Typed Tinybird client for the Strada self-host CLI flow.
//
// Source of truth for these endpoint shapes:
// - Tinybird admin API overview: https://www.tinybird.co/docs/api-reference/api-overview
// - Tinybird deployments docs: https://www.tinybird.co/docs/forward/dev-reference/deployments
// - Tinybird workspace docs: https://www.tinybird.co/docs/forward/dev-reference/workspace
// - Tinybird OpenAPI docs for published query endpoints: https://docs.tinybird.co/api-endpoints/
//
// Important: Tinybird publishes OpenAPI 3.0 for query endpoints, but I could
// not find a stable public OpenAPI file for the v1 admin endpoints used here.
// For those admin endpoints, the concrete response shapes here are aligned with
// Tinybird's own SDK declarations:
// - public export: @tinybirdco/sdk/api/workspaces
// - @tinybirdco/sdk/dist/api/workspaces.d.ts
// - @tinybirdco/sdk/dist/api/deploy.d.ts
// - @tinybirdco/sdk/dist/cli/auth.d.ts

import type { TinybirdWorkspace } from "@tinybirdco/sdk/api/workspaces";
import * as errore from "errore";

/**
 * All Tinybird datasource names that user queries can read.
 * Used to generate per-project JWTs with DATASOURCES:READ scopes.
 */
export const TINYBIRD_DATASOURCES = [
  "otel_traces",
  "otel_traces_trace_id_ts",
  "otel_logs",
  "otel_errors",
  "otel_metrics_gauge",
  "otel_metrics_sum",
  "otel_metrics_histogram",
  "otel_metrics_exponential_histogram",
  "otel_analytics_pages",
  "otel_analytics_sessions",
] as const;

export interface TinybirdResourceFile {
  name: string;
  content: string;
}

export interface TinybirdDeploymentError {
  filename?: string;
  error: string;
}

export interface TinybirdDeployment {
  id: string;
  status: string;
  live?: boolean;
}

export interface TinybirdDeploymentDetails extends TinybirdDeployment {
  new_datasource_names?: string[];
  new_pipe_names?: string[];
  errors?: TinybirdDeploymentError[];
}

export interface TinybirdDeployResponse {
  result: "success" | "failed" | "no_changes";
  deployment?: TinybirdDeploymentDetails;
  error?: string;
  errors?: TinybirdDeploymentError[];
}

export interface TinybirdDeploymentStatusResponse {
  result: string;
  deployment: TinybirdDeployment;
}

export interface TinybirdCliLoginResponse {
  workspace_token: string;
  user_token: string;
  api_host: string;
  workspace_name?: string;
  user_email?: string;
}

export interface TinybirdToken {
  token: string;
  name: string;
  description?: string;
  scopes: Array<{ type: string; resource?: string; filter?: string; fixed_params?: Record<string, string | number> }>;
}

/** Scope definition for creating JWTs via POST /v0/tokens. */
export interface TinybirdJwtScope {
  type: "DATASOURCES:READ" | "PIPES:READ";
  resource: string;
  filter?: string;
  fixed_params?: Record<string, string | number>;
}

export interface TinybirdJwtOptions {
  name: string;
  /** Unix timestamp in seconds when the JWT expires. */
  expirationTime: number;
  scopes: TinybirdJwtScope[];
}

export interface TinybirdTokensListResponse {
  tokens: TinybirdToken[];
}

class TinybirdResponseShapeError extends errore.createTaggedError({
  name: "TinybirdResponseShapeError",
  message: "Tinybird returned an invalid response for $operation. $details",
}) {}

class TinybirdRequestError extends errore.createTaggedError({
  name: "TinybirdRequestError",
  message: "Tinybird request failed for $operation at $baseUrl. $details",
}) {}

function formatBodyForError(body: string) {
  const trimmed = body.trim()
  if (!trimmed) return "Response body was empty."
  if (trimmed.length <= 1200) return `Response body: ${trimmed}`
  return `Response body: ${trimmed.slice(0, 1200)}…`
}

function expectObject({ value, operation }: { value: unknown; operation: string }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return new TinybirdResponseShapeError({
      operation,
      details: `Expected an object but received ${Array.isArray(value) ? "an array" : String(value)}.`,
    });
  }

  const record: Record<string, unknown> = {};
  Object.assign(record, value);
  return record;
}

function expectString({ record, key, operation }: { record: Record<string, unknown>; key: string; operation: string }) {
  const value = record[key];
  if (typeof value !== "string") {
    return new TinybirdResponseShapeError({
      operation,
      details: `Expected field ${key} to be a string but received ${JSON.stringify(value)}. Response keys: ${Object.keys(record).sort().join(", ")}. Response body: ${JSON.stringify(record).slice(0, 1200)}`,
    });
  }

  return value;
}

function optionalString({ record, key }: { record: Record<string, unknown>; key: string }) {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean({ record, key }: { record: Record<string, unknown>; key: string }) {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalStringArray({ record, key }: { record: Record<string, unknown>; key: string }) {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function parseScopes({ record, key, operation }: { record: Record<string, unknown>; key: string; operation: string }) {
  const value = record[key]
  if (!Array.isArray(value)) {
    return new TinybirdResponseShapeError({
      operation,
      details: `Expected field ${key} to be an array but received ${JSON.stringify(value)}. Response body: ${JSON.stringify(record).slice(0, 1200)}`,
    })
  }

  const scopes: TinybirdToken["scopes"] = []
  for (const item of value) {
    const scopeRecord = expectObject({ value: item, operation: `${operation} scope item` })
    if (scopeRecord instanceof Error) return scopeRecord

    const type = expectString({ record: scopeRecord, key: "type", operation: `${operation} scope.type` })
    if (type instanceof Error) return type

    scopes.push({
      type,
      ...(optionalString({ record: scopeRecord, key: "resource" }) ? { resource: optionalString({ record: scopeRecord, key: "resource" }) } : undefined),
      ...(optionalString({ record: scopeRecord, key: "filter" }) ? { filter: optionalString({ record: scopeRecord, key: "filter" }) } : undefined),
    })
  }

  return scopes
}

function parseDeploymentError({ value }: { value: unknown }) {
  const record = expectObject({ value, operation: "deployment error item" });
  if (record instanceof Error) return record;

  const error = optionalString({ record, key: "error" });
  if (!error) return null;

  return {
    error,
    filename: optionalString({ record, key: "filename" }),
  } satisfies TinybirdDeploymentError;
}

function parseDeploymentErrors({ record, key }: { record: Record<string, unknown>; key: string }) {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    return new TinybirdResponseShapeError({
      operation: `deployment errors.${key}`,
      details: `Expected ${key} to be an array but received ${JSON.stringify(value)}. Response body: ${JSON.stringify(record).slice(0, 1200)}`,
    })
  }

  const errors: TinybirdDeploymentError[] = [];
  for (const item of value) {
    const parsed = parseDeploymentError({ value: item });
    if (parsed instanceof Error) return parsed;
    if (parsed) errors.push(parsed);
  }

  return errors;
}

function parseWorkspace({ value }: { value: unknown }) {
  const record = expectObject({ value, operation: "workspace" });
  if (record instanceof Error) return record;

  const id = expectString({ record, key: "id", operation: "workspace.id" });
  if (id instanceof Error) return id;
  const name = expectString({ record, key: "name", operation: "workspace.name" });
  if (name instanceof Error) return name;
  const userId = expectString({ record, key: "user_id", operation: "workspace.user_id" });
  if (userId instanceof Error) return userId;
  const userEmail = expectString({ record, key: "user_email", operation: "workspace.user_email" });
  if (userEmail instanceof Error) return userEmail;
  const scope = expectString({ record, key: "scope", operation: "workspace.scope" });
  if (scope instanceof Error) return scope;

  return {
    id,
    name,
    user_id: userId,
    user_email: userEmail,
    scope,
    main: record.main === null ? null : optionalString({ record, key: "main" }) || null,
  } satisfies TinybirdWorkspace;
}

function parseDeployment({ value }: { value: unknown }) {
  const record = expectObject({ value, operation: "deployment" });
  if (record instanceof Error) return record;

  const id = optionalString({ record, key: "id" });
  const status = optionalString({ record, key: "status" });
  if (!id || !status) {
    return new TinybirdResponseShapeError({
      operation: "deployment",
      details: `Expected deployment to include string id and status. Received id=${JSON.stringify(record.id)} status=${JSON.stringify(record.status)}. Response body: ${JSON.stringify(record).slice(0, 1200)}`,
    })
  }

  return {
    id,
    status,
    live: optionalBoolean({ record, key: "live" }),
  } satisfies TinybirdDeployment;
}

function parseDeploymentDetails({ value }: { value: unknown }) {
  const deployment = parseDeployment({ value });
  if (deployment instanceof Error) return deployment;

  const record = expectObject({ value, operation: "deployment details" });
  if (record instanceof Error) return record;

  const errors = parseDeploymentErrors({ record, key: "errors" });
  if (errors instanceof Error) return errors;

  return {
    ...deployment,
    new_datasource_names: optionalStringArray({ record, key: "new_datasource_names" }),
    new_pipe_names: optionalStringArray({ record, key: "new_pipe_names" }),
    errors,
  } satisfies TinybirdDeploymentDetails;
}

function parseDeploymentsList({ value }: { value: unknown }) {
  const record = expectObject({ value, operation: "deployments list" });
  if (record instanceof Error) return record;

  const deployments = record.deployments;
  if (deployments === undefined) return [];
  if (!Array.isArray(deployments)) {
    return new TinybirdResponseShapeError({
      operation: "deployments list.deployments",
      details: `Expected deployments to be an array but received ${JSON.stringify(deployments)}. Response body: ${JSON.stringify(record).slice(0, 1200)}`,
    })
  }

  const parsed: TinybirdDeployment[] = [];
  for (const item of deployments) {
    const deployment = parseDeployment({ value: item });
    if (deployment instanceof Error) return deployment;
    if (deployment) parsed.push(deployment);
  }

  return parsed;
}

function parseDeployResponse({ value }: { value: unknown }) {
  const record = expectObject({ value, operation: "deploy response" });
  if (record instanceof Error) return record;

  const result = optionalString({ record, key: "result" });
  if (result !== "success" && result !== "failed" && result !== "no_changes") {
    return new TinybirdResponseShapeError({
      operation: "deploy result",
      details: `Expected result to be one of success, failed, no_changes but received ${JSON.stringify(result)}. Response body: ${JSON.stringify(record).slice(0, 1200)}`,
    });
  }

  const deployment = record.deployment ? parseDeploymentDetails({ value: record.deployment }) : undefined;
  if (deployment instanceof Error) return deployment;

  const errors = parseDeploymentErrors({ record, key: "errors" });
  if (errors instanceof Error) return errors;

  return {
    result,
    deployment: deployment === null ? undefined : deployment,
    error: optionalString({ record, key: "error" }),
    errors,
  } satisfies TinybirdDeployResponse;
}

function parseDeploymentStatusResponse({ value }: { value: unknown }) {
  const record = expectObject({ value, operation: "deployment status" });
  if (record instanceof Error) return record;

  const deployment = parseDeployment({ value: record.deployment });
  if (deployment instanceof Error) return deployment;
  if (deployment === null) {
    return new TinybirdResponseShapeError({
      operation: "deployment status payload",
      details: `Expected deployment object with id and status. Response body: ${JSON.stringify(record).slice(0, 1200)}`,
    });
  }

  return {
    result: optionalString({ record, key: "result" }) || "unknown",
    deployment,
  } satisfies TinybirdDeploymentStatusResponse;
}

function parseTokenResponse({ value }: { value: unknown }) {
  const record = expectObject({ value, operation: "create token" });
  if (record instanceof Error) return record;

  const token = expectString({ record, key: "token", operation: "token.token" });
  if (token instanceof Error) return token;
  const name = expectString({ record, key: "name", operation: "token.name" });
  if (name instanceof Error) return name;
  const scopes = parseScopes({ record, key: "scopes", operation: "token.scopes" })
  if (scopes instanceof Error) return scopes

  return { token, name, scopes } satisfies TinybirdToken;
}

function parseTokensListResponse({ value }: { value: unknown }) {
  const record = expectObject({ value, operation: "list tokens" })
  if (record instanceof Error) return record

  const valueTokens = record.tokens
  if (!Array.isArray(valueTokens)) {
    return new TinybirdResponseShapeError({
      operation: "list tokens.tokens",
      details: `Expected tokens to be an array but received ${JSON.stringify(valueTokens)}. Response body: ${JSON.stringify(record).slice(0, 1200)}`,
    })
  }

  const tokens: TinybirdToken[] = []
  for (const item of valueTokens) {
    const tokenRecord = expectObject({ value: item, operation: "list tokens token item" })
    if (tokenRecord instanceof Error) return tokenRecord

    const token = expectString({ record: tokenRecord, key: "token", operation: "list tokens token.token" })
    if (token instanceof Error) return token
    const name = expectString({ record: tokenRecord, key: "name", operation: "list tokens token.name" })
    if (name instanceof Error) return name
    const scopes = parseScopes({ record: tokenRecord, key: "scopes", operation: "list tokens token.scopes" })
    if (scopes instanceof Error) return scopes

    tokens.push({
      token,
      name,
      scopes,
      ...(optionalString({ record: tokenRecord, key: "description" }) ? { description: optionalString({ record: tokenRecord, key: "description" }) } : undefined),
    })
  }

  return { tokens } satisfies TinybirdTokensListResponse
}

function parseCliLoginResponse({ value }: { value: unknown }) {
  const record = expectObject({ value, operation: "cli login" });
  if (record instanceof Error) return record;

  const workspaceToken = expectString({ record, key: "workspace_token", operation: "cli login workspace_token" });
  if (workspaceToken instanceof Error) return workspaceToken;
  const userToken = expectString({ record, key: "user_token", operation: "cli login user_token" });
  if (userToken instanceof Error) return userToken;
  const apiHost = expectString({ record, key: "api_host", operation: "cli login api_host" });
  if (apiHost instanceof Error) return apiHost;

  return {
    workspace_token: workspaceToken,
    user_token: userToken,
    api_host: apiHost,
    workspace_name: optionalString({ record, key: "workspace_name" }),
    user_email: optionalString({ record, key: "user_email" }),
  } satisfies TinybirdCliLoginResponse;
}

function toHttpError({ operation, response }: { operation: string; response: Response }) {
  return response
    .text()
    .then((body) => new TinybirdRequestError({
      operation,
      baseUrl: response.url || "unknown Tinybird endpoint",
      details: `HTTP ${response.status} ${response.statusText}. ${formatBodyForError(body)}`,
      cause: new Error(`HTTP ${response.status} ${response.statusText}: ${body}`),
    }))
    .catch((cause: unknown) => new TinybirdRequestError({
      operation,
      baseUrl: response.url || "unknown Tinybird endpoint",
      details: "Failed to read the error response body.",
      cause,
    }));
}

export class TinybirdClient {
  constructor(
    private readonly config: {
      baseUrl: string;
      token: string;
      fetch?: typeof fetch;
    },
  ) {}

  private get fetchFn(): typeof fetch {
    // Wrap globalThis.fetch so it's called without a bound `this`.
    // Cloudflare Workers throws "Illegal invocation" if fetch is stored
    // in a variable and called with a different `this` reference.
    return this.config.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  private get baseUrl() {
    return this.config.baseUrl.replace(/\/$/, "");
  }

  private async request({ path, init }: { path: string; init?: RequestInit }) {
    const url = `${this.baseUrl}${path}`
    return this.fetchFn(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        ...(init?.headers ?? {}),
      },
    }).catch((cause: unknown) => new TinybirdRequestError({
      operation: path,
      baseUrl: url,
      details: "Network request failed before Tinybird returned a response.",
      cause,
    }));
  }

  private async requestJson<T>({ path, parser, init }: { path: string; parser: (args: { value: unknown }) => Error | T; init?: RequestInit }) {
    const response = await this.request({ path, init });
    if (response instanceof Error) return response;
    if (!response.ok) return toHttpError({ operation: path, response });

    const body = await response.json().catch((cause: unknown) => new TinybirdRequestError({
      operation: `${path} json`,
      baseUrl: response.url || `${this.baseUrl}${path}`,
      details: "Tinybird returned a non-JSON response for a JSON endpoint.",
      cause,
    }));
    if (body instanceof Error) return body;

    return parser({ value: body });
  }

  async getWorkspace() {
    return this.requestJson({ path: "/v1/workspace", parser: parseWorkspace });
  }

  async listDeployments() {
    return this.requestJson({ path: "/v1/deployments", parser: parseDeploymentsList });
  }

  async deleteDeployment({ deploymentId }: { deploymentId: string }) {
    const response = await this.request({ path: `/v1/deployments/${deploymentId}`, init: { method: "DELETE" } });
    if (response instanceof Error) return response;
    if (!response.ok) return toHttpError({ operation: `delete deployment ${deploymentId}`, response });
    return null;
  }

  async createDeployment({ datasources, pipes }: { datasources: TinybirdResourceFile[]; pipes: TinybirdResourceFile[] }) {
    const formData = new FormData();

    for (const datasource of datasources) {
      formData.append("data_project://", new Blob([datasource.content], { type: "text/plain" }), `${datasource.name}.datasource`);
    }

    for (const pipe of pipes) {
      formData.append("data_project://", new Blob([pipe.content], { type: "text/plain" }), `${pipe.name}.pipe`);
    }

    return this.requestJson({
      path: "/v1/deploy",
      parser: parseDeployResponse,
      init: { method: "POST", body: formData },
    });
  }

  async getDeploymentStatus({ deploymentId }: { deploymentId: string }) {
    return this.requestJson({ path: `/v1/deployments/${deploymentId}`, parser: parseDeploymentStatusResponse });
  }

  async promoteDeployment({ deploymentId }: { deploymentId: string }) {
    const response = await this.request({ path: `/v1/deployments/${deploymentId}/set-live`, init: { method: "POST" } });
    if (response instanceof Error) return response;
    if (!response.ok) return toHttpError({ operation: `promote deployment ${deploymentId}`, response });
    return null;
  }

  async createToken({ name, scope }: { name: string; scope: string }) {
    return this.requestJson({
      path: `/v0/tokens/?name=${encodeURIComponent(name)}&scope=${encodeURIComponent(scope)}`,
      parser: parseTokenResponse,
      init: { method: "POST" },
    });
  }

  async listTokens() {
    return this.requestJson({ path: "/v0/tokens", parser: parseTokensListResponse })
  }

  /**
   * Create a Tinybird JWT with scoped permissions and expiration.
   * Requires an admin token. The JWT is signed by Tinybird using the admin
   * token as shared secret, so it can be used directly as a Bearer token
   * against /v0/sql with server-enforced filters.
   *
   * Tinybird API: POST /v0/tokens?name=...&expiration_time=<unix_seconds>
   * Body: { scopes: [...] }
   */
  async createJwt({ name, expirationTime, scopes }: TinybirdJwtOptions) {
    const params = new URLSearchParams({
      name,
      expiration_time: String(expirationTime),
    })
    return this.requestJson({
      path: `/v0/tokens?${params}`,
      parser: parseTokenResponse,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopes }),
      },
    })
  }
}

export async function exchangeTinybirdCliCode({ authHost, code, fetch: customFetch }: { authHost: string; code: string; fetch?: typeof fetch }) {
  const fetchFn = customFetch ?? fetch;
  const url = new URL("/api/cli-login", authHost);
  url.searchParams.set("code", code);

  const response = await fetchFn(url.toString()).catch(
    (cause: unknown) => new TinybirdRequestError({
      operation: "cli login exchange",
      baseUrl: url.toString(),
      details: "Could not reach Tinybird CLI login exchange endpoint.",
      cause,
    }),
  );
  if (response instanceof Error) return response;
  if (!response.ok) return toHttpError({ operation: "cli login exchange", response });

  const body = await response.json().catch(
    (cause: unknown) => new TinybirdRequestError({
      operation: "cli login exchange json",
      baseUrl: url.toString(),
      details: "Tinybird CLI login exchange returned invalid JSON.",
      cause,
    }),
  );
  if (body instanceof Error) return body;

  return parseCliLoginResponse({ value: body });
}
