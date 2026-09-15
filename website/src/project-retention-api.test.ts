import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { api } from "./api.ts";

async function insertUserSession(id: string, token: string) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, id, `${id}@example.com`, 1, now, now),
    env.DB.prepare(
      "INSERT INTO session (id, user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(`session-${id}`, id, token, now + 60_000, now, now),
  ]);
}

async function requestProjectRetention({
  token,
  method = "GET",
  body,
}: {
  token: string;
  method?: "GET" | "PUT";
  body?: Record<string, unknown>;
}) {
  return api.handle(new Request("http://localhost/api/v0/projects/project-one/retention", {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }));
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM session"),
    env.DB.prepare("DELETE FROM org_member"),
    env.DB.prepare("DELETE FROM project"),
    env.DB.prepare("DELETE FROM database"),
    env.DB.prepare("DELETE FROM org"),
    env.DB.prepare("DELETE FROM user"),
  ]);

  await insertUserSession("admin", "admin-token");
  await insertUserSession("member", "member-token");
  await insertUserSession("outside", "outside-token");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO org (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind("org-one", "One", now, now),
    env.DB.prepare(
      "INSERT INTO database (id, org_id, backend, clickhouse_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("database-one", "org-one", "clickhouse", "http://clickhouse.test", now, now),
    env.DB.prepare(
      "INSERT INTO org_member (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("membership-admin", "org-one", "admin", "admin", now),
    env.DB.prepare(
      "INSERT INTO org_member (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("membership-member", "org-one", "member", "member", now),
    env.DB.prepare(
      "INSERT INTO project (id, slug, org_id, database_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("project-one", "one", "org-one", "database-one", now, now),
  ]);
});

describe("project retention API", () => {
  test("lets organization members read retention", async () => {
    const response = await requestProjectRetention({ token: "member-token" });
    expect({ status: response.status, body: await response.json() }).toMatchInlineSnapshot(`
      {
        "body": {
          "errorsDays": null,
          "logsDays": null,
          "metricsDays": null,
          "tracesDays": null,
        },
        "status": 200,
      }
    `);
  });

  test("rejects retention updates from members", async () => {
    const response = await requestProjectRetention({
      token: "member-token",
      method: "PUT",
      body: { tracesDays: 7 },
    });
    expect(response.status).toBe(403);
  });

  test("hides projects from users outside the organization", async () => {
    const getResponse = await requestProjectRetention({ token: "outside-token" });
    const putResponse = await requestProjectRetention({
      token: "outside-token",
      method: "PUT",
      body: { tracesDays: 7 },
    });
    expect([getResponse.status, putResponse.status]).toEqual([404, 404]);
  });

  test("rejects empty and invalid updates", async () => {
    const emptyResponse = await requestProjectRetention({
      token: "admin-token",
      method: "PUT",
      body: {},
    });
    const invalidResponse = await requestProjectRetention({
      token: "admin-token",
      method: "PUT",
      body: { tracesDays: 0 },
    });
    const keepResponse = await requestProjectRetention({
      token: "admin-token",
      method: "PUT",
      body: { tracesDays: null },
    });
    const keepAllResponse = await requestProjectRetention({
      token: "admin-token",
      method: "PUT",
      body: { tracesDays: null, logsDays: null, errorsDays: null, metricsDays: null },
    });
    expect([emptyResponse.status, invalidResponse.status, keepResponse.status, keepAllResponse.status]).toEqual([400, 400, 400, 400]);
    const keepBody: { error?: string } = await keepResponse.json()
    const keepAllBody: { error?: string } = await keepAllResponse.json()
    expect(keepBody.error).not.toBe('pass at least one retention field')
    expect(keepAllBody.error).not.toBe('pass at least one retention field')
  });

  test("does not store inert custom values for ClickHouse", async () => {
    const response = await requestProjectRetention({
      token: "admin-token",
      method: "PUT",
      body: { tracesDays: 7 },
    });
    const row = await env.DB.prepare(
      "SELECT traces_retention_days FROM project WHERE id = ?",
    ).bind("project-one").first<{ traces_retention_days: number }>();
    expect({ status: response.status, tracesDays: row?.traces_retention_days }).toEqual({
      status: 400,
      tracesDays: null,
    });
  });

});
