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

export class TinybirdClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "TinybirdClientError";
  }
}

function expectObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TinybirdClientError(message);
  }

  return Object.fromEntries(Object.entries(value));
}

function expectString(record: Record<string, unknown>, key: string, message: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new TinybirdClientError(message);
  }

  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function parseDeploymentError(value: unknown): TinybirdDeploymentError | undefined {
  const record = expectObject(value, "Expected Tinybird deployment error object");
  const error = optionalString(record, "error");
  if (!error) {
    return undefined;
  }

  return {
    error,
    filename: optionalString(record, "filename"),
  };
}

function optionalDeploymentErrors(record: Record<string, unknown>, key: string): TinybirdDeploymentError[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap((item) => {
    const parsed = parseDeploymentError(item);
    return parsed ? [parsed] : [];
  });
}

function parseWorkspace(value: unknown): TinybirdWorkspace {
  const record = expectObject(value, "Expected Tinybird workspace response");
  return {
    id: expectString(record, "id", "Missing Tinybird workspace id"),
    name: expectString(record, "name", "Missing Tinybird workspace name"),
    user_id: expectString(record, "user_id", "Missing Tinybird workspace user_id"),
    user_email: expectString(record, "user_email", "Missing Tinybird workspace user_email"),
    scope: expectString(record, "scope", "Missing Tinybird workspace scope"),
    main: record.main === null ? null : optionalString(record, "main") || null,
  };
}

function parseDeployment(value: unknown): TinybirdDeployment | undefined {
  const record = expectObject(value, "Expected Tinybird deployment object");
  const id = optionalString(record, "id");
  const status = optionalString(record, "status");
  if (!id || !status) {
    return undefined;
  }

  return {
    id,
    status,
    live: optionalBoolean(record, "live"),
  };
}

function parseDeploymentDetails(value: unknown): TinybirdDeploymentDetails | undefined {
  const base = parseDeployment(value);
  if (!base) {
    return undefined;
  }

  const record = expectObject(value, "Expected Tinybird deployment details object");
  return {
    ...base,
    new_datasource_names: optionalStringArray(record, "new_datasource_names"),
    new_pipe_names: optionalStringArray(record, "new_pipe_names"),
    errors: optionalDeploymentErrors(record, "errors"),
  };
}

function parseDeploymentsList(value: unknown): TinybirdDeployment[] {
  const record = expectObject(value, "Expected Tinybird deployments list response");
  const deployments = record.deployments;
  if (!Array.isArray(deployments)) {
    return [];
  }

  return deployments.flatMap((item) => {
    const parsed = parseDeployment(item);
    return parsed ? [parsed] : [];
  });
}

function parseDeployResponse(value: unknown): TinybirdDeployResponse {
  const record = expectObject(value, "Expected Tinybird deploy response");
  const result = optionalString(record, "result");
  if (result !== "success" && result !== "failed" && result !== "no_changes") {
    throw new TinybirdClientError("Unexpected Tinybird deploy result");
  }

  return {
    result,
    deployment: record.deployment ? parseDeploymentDetails(record.deployment) : undefined,
    error: optionalString(record, "error"),
    errors: optionalDeploymentErrors(record, "errors"),
  };
}

function parseDeploymentStatusResponse(value: unknown): TinybirdDeploymentStatusResponse {
  const record = expectObject(value, "Expected Tinybird deployment status response");
  const deployment = parseDeployment(record.deployment);
  if (!deployment) {
    throw new TinybirdClientError("Unexpected Tinybird deployment status response");
  }

  return {
    result: optionalString(record, "result") || "unknown",
    deployment,
  };
}

function parseCliLoginResponse(value: unknown): TinybirdCliLoginResponse {
  const record = expectObject(value, "Expected Tinybird CLI login response");
  return {
    workspace_token: expectString(record, "workspace_token", "Missing Tinybird workspace_token"),
    user_token: expectString(record, "user_token", "Missing Tinybird user_token"),
    api_host: expectString(record, "api_host", "Missing Tinybird api_host"),
    workspace_name: optionalString(record, "workspace_name"),
    user_email: optionalString(record, "user_email"),
  };
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
    return this.config.fetch ?? fetch;
  }

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/$/, "");
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    return this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        ...(init?.headers ?? {}),
      },
    });
  }

  private async requestJson<T>(path: string, parser: (value: unknown) => T, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) {
      throw new TinybirdClientError(
        `Tinybird request failed: ${response.status} ${response.statusText}`,
        response.status,
        await response.text(),
      );
    }

    return parser(await response.json());
  }

  async getWorkspace(): Promise<TinybirdWorkspace> {
    return this.requestJson("/v1/workspace", parseWorkspace);
  }

  async listDeployments(): Promise<TinybirdDeployment[]> {
    return this.requestJson("/v1/deployments", parseDeploymentsList);
  }

  async deleteDeployment(deploymentId: string): Promise<void> {
    const response = await this.request(`/v1/deployments/${deploymentId}`, { method: "DELETE" });
    if (!response.ok) {
      throw new TinybirdClientError(
        `Failed to delete Tinybird deployment ${deploymentId}`,
        response.status,
        await response.text(),
      );
    }
  }

  async createDeployment(resources: {
    datasources: TinybirdResourceFile[];
    pipes: TinybirdResourceFile[];
  }): Promise<TinybirdDeployResponse> {
    const formData = new FormData();

    for (const datasource of resources.datasources) {
      formData.append("data_project://", new Blob([datasource.content], { type: "text/plain" }), `${datasource.name}.datasource`);
    }

    for (const pipe of resources.pipes) {
      formData.append("data_project://", new Blob([pipe.content], { type: "text/plain" }), `${pipe.name}.pipe`);
    }

    return this.requestJson("/v1/deploy", parseDeployResponse, {
      method: "POST",
      body: formData,
    });
  }

  async getDeploymentStatus(deploymentId: string): Promise<TinybirdDeploymentStatusResponse> {
    return this.requestJson(`/v1/deployments/${deploymentId}`, parseDeploymentStatusResponse);
  }

  async promoteDeployment(deploymentId: string): Promise<void> {
    const response = await this.request(`/v1/deployments/${deploymentId}/set-live`, { method: "POST" });
    if (!response.ok) {
      throw new TinybirdClientError(
        `Failed to promote Tinybird deployment ${deploymentId}`,
        response.status,
        await response.text(),
      );
    }
  }
}

export async function exchangeTinybirdCliCode(args: {
  authHost: string;
  code: string;
  fetch?: typeof fetch;
}): Promise<TinybirdCliLoginResponse> {
  const fetchFn = args.fetch ?? fetch;
  const url = new URL("/api/cli-login", args.authHost);
  url.searchParams.set("code", args.code);

  const response = await fetchFn(url.toString());
  if (!response.ok) {
    throw new TinybirdClientError(
      `Tinybird CLI login exchange failed: ${response.status} ${response.statusText}`,
      response.status,
      await response.text(),
    );
  }

  return parseCliLoginResponse(await response.json());
}
