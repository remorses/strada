// Resolves project config from the shared D1 database.
// The collector has a D1 binding to the same database as the website.
// Reads the project + database tables to get storage credentials.

import type { ProjectConfig } from "./env.ts";

// Raw SQL query against D1 because the collector doesn't use drizzle-orm
// (it would add unnecessary weight). A single JOIN query is sufficient.
const RESOLVE_SQL = `
  SELECT
    p.id AS project_id,
    d.backend,
    d.tinybird_endpoint,
    d.tinybird_admin_token,
    d.clickhouse_url,
    d.clickhouse_database,
    d.clickhouse_user,
    d.clickhouse_password
  FROM project p
  JOIN database d ON p.database_id = d.id
  WHERE p.id = ?
  LIMIT 1
`;

export async function resolveProjectConfig(
  db: D1Database,
  projectId: string,
): Promise<ProjectConfig | null> {
  if (!projectId) return null;

  const row = await db
    .prepare(RESOLVE_SQL)
    .bind(projectId)
    .first<{
      project_id: string;
      backend: "tinybird" | "clickhouse";
      tinybird_endpoint: string | null;
      tinybird_admin_token: string | null;
      clickhouse_url: string | null;
      clickhouse_database: string | null;
      clickhouse_user: string | null;
      clickhouse_password: string | null;
    }>();

  if (!row) return null;

  return {
    projectId: row.project_id,
    backend: row.backend,
    tinybirdEndpoint: row.tinybird_endpoint,
    tinybirdAdminToken: row.tinybird_admin_token,
    clickhouseUrl: row.clickhouse_url,
    clickhouseDatabase: row.clickhouse_database,
    clickhouseUser: row.clickhouse_user,
    clickhousePassword: row.clickhouse_password,
  };
}
