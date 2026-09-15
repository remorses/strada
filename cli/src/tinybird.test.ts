import { describe, expect, test } from "vitest";
import { TinybirdClient, deployTinybirdResources } from "./tinybird.ts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TinybirdClient.listDeployments", () => {
  test("accepts numeric deployment ids from Tinybird", async () => {
    const client = new TinybirdClient({
      baseUrl: "https://api.eu-west-1.aws.tinybird.co",
      token: "t",
      fetch: async () =>
        jsonResponse({
          deployments: [{ id: 8, status: "calculating", live: false }],
        }),
    });

    await expect(client.listDeployments()).resolves.toEqual([
      { id: "8", status: "calculating", live: false },
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
