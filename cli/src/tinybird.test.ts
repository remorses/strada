import { describe, expect, test } from "vitest";
import { TinybirdClient, deployTinybirdResources } from "./tinybird.ts";
import { extractEngineTtl, renderTinybirdRetention } from "./tinybird-retention.ts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("renderTinybirdRetention", () => {
  test("casts DateTime64 columns to DateTime in TTL expressions", () => {
    const rendered = renderTinybirdRetention({
      datasources: [
        { name: "otel_traces", content: 'ENGINE_SORTING_KEY "ProjectId"\nENGINE_SETTINGS index_granularity=8192' },
        { name: "otel_logs", content: 'ENGINE_SORTING_KEY "ProjectId"\nENGINE_SETTINGS index_granularity=8192' },
        { name: "otel_metrics_gauge", content: 'ENGINE_SORTING_KEY "ProjectId"\nENGINE_SETTINGS index_granularity=8192' },
      ],
      projects: [{
        id: "project-a",
        tracesRetentionDays: 7,
        logsRetentionDays: null,
        errorsRetentionDays: null,
        metricsRetentionDays: 60,
      }],
    });

    expect(rendered.map((resource) => [
      resource.name,
      extractEngineTtl(resource.content),
    ])).toMatchInlineSnapshot(`
      [
        [
          "otel_traces",
          "toDateTime(Timestamp) + toIntervalDay(7) DELETE WHERE ProjectId IN ('project-a')",
        ],
        [
          "otel_logs",
          null,
        ],
        [
          "otel_metrics_gauge",
          "toDateTime(TimeUnix) + toIntervalDay(60) DELETE WHERE ProjectId IN ('project-a')",
        ],
      ]
    `);
  });
});

describe("TinybirdClient.listDeployments", () => {
  test("accepts numeric deployment ids from Tinybird", async () => {
    const client = new TinybirdClient({
      baseUrl: "https://api.eu-west-1.aws.tinybird.co",
      token: "t",
      fetch: async () =>
        jsonResponse({
          deployments: [{ id: 8, status: "calculating", live: false, created_at: "2026-09-15T15:27:38.940179" }],
        }),
    });

    await expect(client.listDeployments()).resolves.toEqual([
      { id: "8", status: "calculating", live: false, createdAt: "2026-09-15T15:27:38.940179" },
    ]);
  });
});

describe("TinybirdClient.createDeployment", () => {
  test("parses HTTP 400 failed deploy bodies so in-flight deploys can be adopted", async () => {
    const client = new TinybirdClient({
      baseUrl: "https://api.eu-west-1.aws.tinybird.co",
      token: "t",
      fetch: async () =>
        jsonResponse(
          {
            result: "failed",
            deployment: {
              id: 8,
              status: "calculating",
              live: false,
              feedback: [
                {
                  resource: null,
                  level: "ERROR",
                  message: "There's already a deployment in progress.",
                },
              ],
            },
          },
          400,
        ),
    });

    await expect(
      client.createDeployment({ datasources: [], pipes: [] }),
    ).resolves.toMatchObject({
      result: "failed",
      deployment: {
        id: "8",
        status: "calculating",
        live: false,
        feedback: [
          {
            resource: null,
            level: "ERROR",
            message: "There's already a deployment in progress.",
          },
        ],
      },
    });
  });
});

describe("deployTinybirdResources", () => {
  test("ignores the retained rollback staging deployment", async () => {
    const calls: string[] = [];
    const client = {
      listDeployments: async () => [
        { id: "8", status: "live", live: true },
        { id: "3", status: "staging", live: false },
      ],
      deleteDeployment: async ({ deploymentId }: { deploymentId: string }) => {
        calls.push(`delete:${deploymentId}`);
        return null;
      },
      createDeployment: async () => {
        calls.push("create");
        return { result: "no_changes" as const };
      },
      getDeploymentStatus: async ({ deploymentId }: { deploymentId: string }) => {
        calls.push(`status:${deploymentId}`);
        return new Error("unexpected status call");
      },
      promoteDeployment: async ({ deploymentId }: { deploymentId: string }) => {
        calls.push(`promote:${deploymentId}`);
        return null;
      },
    };

    await expect(deployTinybirdResources({ client, datasources: [], pipes: [] }))
      .resolves.toEqual({ result: "no_changes" });
    expect(calls).toEqual(["create"]);
  });

  test("ignores a leftover data_ready rollback that is older than live", async () => {
    const calls: string[] = [];
    const client = {
      listDeployments: async () => [
        { id: "8", status: "data_ready", live: true, createdAt: "2026-09-15T15:27:38.940179" },
        { id: "3", status: "data_ready", live: false, createdAt: "2026-05-21T07:55:56.127732" },
      ],
      deleteDeployment: async ({ deploymentId }: { deploymentId: string }) => {
        calls.push(`delete:${deploymentId}`);
        return null;
      },
      createDeployment: async () => {
        calls.push("create");
        return { result: "no_changes" as const };
      },
      getDeploymentStatus: async ({ deploymentId }: { deploymentId: string }) => {
        calls.push(`status:${deploymentId}`);
        return new Error("unexpected status call");
      },
      promoteDeployment: async ({ deploymentId }: { deploymentId: string }) => {
        calls.push(`promote:${deploymentId}`);
        return null;
      },
    };

    await expect(deployTinybirdResources({ client, datasources: [], pipes: [] }))
      .resolves.toEqual({ result: "no_changes" });
    expect(calls).toEqual(["create"]);
  });

  test("does not mutate an unknown non-live deployment state", async () => {
    const calls: string[] = [];
    const client = {
      listDeployments: async () => [{ id: "9", status: "future_state", live: false }],
      deleteDeployment: async () => {
        calls.push("delete");
        return null;
      },
      createDeployment: async () => {
        calls.push("create");
        return { result: "no_changes" as const };
      },
      getDeploymentStatus: async () => {
        calls.push("status");
        return new Error("unexpected status call");
      },
      promoteDeployment: async () => {
        calls.push("promote");
        return null;
      },
    };

    const result = await deployTinybirdResources({ client, datasources: [], pipes: [] });
    expect(result).toEqual(new Error('Deployment 9 has unsupported status "future_state"'));
    expect(calls).toEqual([]);
  });

  test("adopts creating_schema as an in-flight deployment", async () => {
    const calls: string[] = [];
    const client = {
      listDeployments: async () => [{ id: "9", status: "creating_schema", live: false, createdAt: "2026-09-15T17:30:00.000Z" }],
      deleteDeployment: async () => {
        calls.push("delete");
        return null;
      },
      createDeployment: async () => {
        calls.push("create");
        return { result: "no_changes" as const };
      },
      getDeploymentStatus: async () => {
        calls.push("status");
        return {
          result: "ok",
          deployment: { id: "9", status: "data_ready", live: false },
        };
      },
      promoteDeployment: async () => {
        calls.push("promote");
        return null;
      },
    };

    const result = await deployTinybirdResources({ client, datasources: [], pipes: [] });
    expect(result).toEqual({ result: "no_changes" });
    expect(calls).toEqual(["status", "promote", "create"]);
  });

  test("adopts an in-flight listed deployment, then diffs the target bundle", async () => {
    const calls: string[] = [];
    const client = {
      listDeployments: async () => {
        calls.push("list");
        return [{ id: "8", status: "calculating", live: false }];
      },
      deleteDeployment: async () => {
        calls.push("delete");
        return null;
      },
      createDeployment: async () => {
        calls.push("create");
        return { result: "no_changes" as const };
      },
      getDeploymentStatus: async () => {
        calls.push("status");
        return {
          result: "ok",
          deployment: { id: "8", status: "data_ready", live: false },
        };
      },
      promoteDeployment: async () => {
        calls.push("promote");
        return null;
      },
    };

    const result = await deployTinybirdResources({
      client,
      datasources: [],
      pipes: [],
    });

    expect(result).toEqual({ result: "no_changes" });
    expect(calls).toEqual(["list", "status", "promote", "create"]);
  });

  test("returns in_progress when Tinybird already has a deploy and list is empty", async () => {
    const calls: string[] = [];
    const client = {
      listDeployments: async () => {
        calls.push("list");
        return [];
      },
      deleteDeployment: async () => {
        calls.push("delete");
        return null;
      },
      createDeployment: async () => {
        calls.push("create");
        return {
          result: "failed" as const,
          deployment: {
            id: "8",
            status: "calculating",
            live: false,
            feedback: [
              {
                resource: null,
                level: "ERROR",
                message: "There's already a deployment in progress.",
              },
            ],
          },
        };
      },
      getDeploymentStatus: async () => {
        calls.push("status");
        return new Error("Deployment not found");
      },
      promoteDeployment: async () => {
        calls.push("promote");
        return null;
      },
    };

    const result = await deployTinybirdResources({
      client,
      datasources: [],
      pipes: [],
    });

    expect(result).toEqual({ result: "in_progress" });
    expect(calls).toEqual(["list", "create"]);
  });
});
