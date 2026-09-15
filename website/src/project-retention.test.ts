import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM project"),
    env.DB.prepare("DELETE FROM database"),
    env.DB.prepare("DELETE FROM org"),
  ]);
  await env.DB.prepare(
    "INSERT INTO org (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).bind("org-retention", "Retention", 1, 1).run();
  await env.DB.prepare(
    "INSERT INTO database (id, org_id, backend, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).bind("database-retention", "org-retention", "tinybird", 1, 1).run();
});

test("project retention columns keep all raw telemetry by default", async () => {
  await env.DB.prepare(
    "INSERT INTO project (id, slug, org_id, database_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind("project-retention", "retention", "org-retention", "database-retention", 1, 1).run();

  const row = await env.DB.prepare(
    "SELECT traces_retention_days, logs_retention_days, errors_retention_days, metrics_retention_days FROM project WHERE id = ?",
  ).bind("project-retention").first();

  expect(row).toMatchInlineSnapshot(`
    {
      "errors_retention_days": null,
      "logs_retention_days": null,
      "metrics_retention_days": null,
      "traces_retention_days": null,
    }
  `);
});

test("D1 accepts keep and the supported day range", async () => {
  await env.DB.prepare(
    "INSERT INTO project (id, slug, org_id, database_id, traces_retention_days, logs_retention_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind("project-ok", "ok", "org-retention", "database-retention", 1, 365, 1, 1).run();
  const row = await env.DB.prepare(
    "SELECT traces_retention_days, logs_retention_days FROM project WHERE id = ?",
  ).bind("project-ok").first();
  expect(row).toEqual({ traces_retention_days: 1, logs_retention_days: 365 });
});

test("D1 rejects retention outside the supported range", async () => {
  await expect(env.DB.prepare(
    "INSERT INTO project (id, slug, org_id, database_id, traces_retention_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind("project-invalid", "invalid", "org-retention", "database-retention", 0, 1, 1).run()).rejects.toThrow();
  await expect(env.DB.prepare(
    "INSERT INTO project (id, slug, org_id, database_id, traces_retention_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind("project-too-long", "too-long", "org-retention", "database-retention", 366, 1, 1).run()).rejects.toThrow();
});
